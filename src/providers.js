// Anthropic Claude as a second provider, and the fallback between providers.
// Gemini stays primary (free tier); when a Gemini call fails (quota 429, 5xx, network) and an
// ANTHROPIC_API_KEY is set, the request runs again on Claude. LLM_PRIMARY=claude swaps the order.
// Raw fetch, like the Gemini calls: the build concatenates src/ into one _worker.js with no bundler,
// so the npm SDK can't be included.

import { SYSTEM, TOOLS, runAgent, geminiAgent, addUsage } from "./agent.js";

export const CLAUDE_API = "https://api.anthropic.com/v1/messages";
export const CLAUDE_VERSION = "2026-10-21";
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
// Models that accept server-side refusal fallback ("fallbacks": "default"). On a safety decline the
// API re-runs the request on Anthropic's recommended model for that refusal category.
const SERVER_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const NUDGE = "Look this up in my profile with your tools before answering.";

// Output caps. Claude is the paid fallback, so a request can't run up a 16k-token bill: answers on
// this site are a few short paragraphs and a tool-call step is a few dozen tokens. Thinking can't be
// turned off on Claude Opus 5.5 and its tokens count toward max_tokens, so effort "low" keeps it
// short enough to leave room for the answer. The job-fit JSON (up to 10 requirements) gets a bit more.
export const CLAUDE_MAX_TOKENS = 1500;
export const CLAUDE_JSON_MAX_TOKENS = 2000;
const CLAUDE_EFFORT = { effort: "low" };

// Global daily budget for the Claude fallback, counted in RATE_KV (one count per Claude run: an
// answer, or one of the two job-fit calls). Past CLAUDE_DAILY_LIMIT the fallback is skipped and the
// visitor gets the normal "busy" reply. Without RATE_KV there is no budget, as before.
export const CLAUDE_DAILY_LIMIT = 200;
export const claudeBudgetKey = (now = new Date()) => `claude:${now.toISOString().slice(0, 10)}`;

function claudeBusy(reason) {
  const err = new Error(reason);
  err.status = 429;
  return err;
}

// true when this Claude run may go ahead (and counts it). Fails closed on KV errors: the per-IP
// limit fails open when KV is down or out of daily writes, and this cap is what still bounds cost
// then. A lost increment under concurrency is fine at this scale.
export async function takeClaudeBudget(env, now = new Date()) {
  const kv = env.RATE_KV;
  if (!kv) return true;
  const limit = parseInt(env.CLAUDE_DAILY_LIMIT, 10);
  const max = Number.isFinite(limit) && limit >= 0 ? limit : CLAUDE_DAILY_LIMIT;
  const key = claudeBudgetKey(now);
  try {
    const n = parseInt((await kv.get(key)) || "0", 10) || 0;
    if (n >= max) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
    return true;
  } catch (err) {
    console.warn("claude budget unavailable, skipping the Claude fallback:", err && err.message);
    return false;
  }
}

// Wraps a Claude attempt so it only runs within the daily budget.
export function withClaudeBudget(env, run) {
  return async () => {
    if (!(await takeClaudeBudget(env))) throw claudeBusy("claude daily budget reached");
    return run();
  };
}

// Gemini's OpenAPI-style schemas ("OBJECT", "STRING") to JSON Schema, with every object closed
// (additionalProperties: false), which strict tools and structured outputs require.
export function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type") out.type = String(v).toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, toJsonSchema(p)]));
    else if (k === "items") out.items = toJsonSchema(v);
    else out[k] = v;
  }
  if (out.type === "object") Object.assign(out, { properties: out.properties || {}, required: out.required || [], additionalProperties: false });
  return out;
}

export function claudeUsage(data) {
  const u = (data && data.usage) || {};
  return { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 };
}

async function claudeRequest(env, body, fetchImpl) {
  const fallback = SERVER_FALLBACK.has(body.model);
  const res = await fetchImpl(CLAUDE_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": CLAUDE_VERSION,
      ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
    },
    body: JSON.stringify(fallback ? { ...body, fallbacks: "default" } : body),
  });
  if (!res.ok) {
    const err = new Error("claude " + res.status);
    err.status = res.status;
    err.detail = await res.text().catch(() => "");
    throw err;
  }
  return res.json();
}

// The agent loop on Claude. Differences from Gemini that the adapter absorbs:
// - Claude Opus 5.5 rejects forced tool use (tool_choice "any"), so the first step runs "auto" and
//   runAgent nudges once if no tool was called; the final step uses "none".
// - The assistant turn is appended verbatim, thinking blocks included: they must be sent back
//   unchanged, and the transcript is only ever appended to.
// - No temperature: API version 2026-10-21 rejects sampling parameters.
export function claudeAgent(env, fetchImpl, system = SYSTEM) {
  const model = env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL;
  const tools = TOOLS[0].functionDeclarations.map((f) => ({
    name: f.name, description: f.description, input_schema: toJsonSchema(f.parameters), strict: true,
  }));
  let messages = [];
  return {
    name: "claude", model, canForce: false,
    start(turns) {
      messages = turns.map((t) => ({ role: t.role, content: t.content }));
    },
    async step(mode) {
      const data = await claudeRequest(env, {
        model, max_tokens: CLAUDE_MAX_TOKENS, output_config: CLAUDE_EFFORT, system, tools,
        tool_choice: { type: mode === "final" ? "none" : "auto" },
        messages,
      }, fetchImpl);
      const content = Array.isArray(data.content) ? data.content : [];
      const usage = claudeUsage(data);
      if (data.stop_reason === "refusal") return { refused: true, text: "", calls: [], usage, model: data.model || model };
      messages.push({ role: "assistant", content });
      // Cut off at max_tokens: a tool call may be half-written, so answer with the text instead.
      const truncated = data.stop_reason === "max_tokens";
      return {
        text: content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
        calls: truncated ? [] : content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
        usage, model: data.model || model,
      };
    },
    addResults(results) {
      // All results go back in one user message, one tool_result per tool_use.
      messages.push({ role: "user", content: results.map((r) => ({
        type: "tool_result", tool_use_id: r.id, content: JSON.stringify(r.result),
        ...(r.result && r.result.error ? { is_error: true } : {}),
      })) });
    },
    nudge() {
      messages.push({ role: "user", content: NUDGE });
    },
  };
}

// One structured-output call on Claude (output_config.format), for the job-fit pipeline.
export async function claudeJSON({ env, system, text, schema, fetchImpl, usage }) {
  const model = env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL;
  const data = await claudeRequest(env, {
    model, max_tokens: CLAUDE_JSON_MAX_TOKENS, system,
    messages: [{ role: "user", content: text }],
    output_config: { ...CLAUDE_EFFORT, format: { type: "json_schema", schema: toJsonSchema(schema) } },
  }, fetchImpl);
  addUsage(usage, claudeUsage(data), data.model || model);
  if (data.stop_reason === "refusal") {
    const err = new Error("claude refused");
    err.status = 422;
    throw err;
  }
  const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(out);
  } catch {
    const err = new Error("claude returned invalid JSON");
    err.status = 502;
    throw err;
  }
}

// Runs attempts in provider order, skipping unconfigured ones; on any error tries the next.
// Returns { value, provider, fallback } where fallback is { from, reason } when the first failed.
export async function withFallback(env, attempts) {
  const list = attempts.filter((a) => a.ok);
  if (env.LLM_PRIMARY === "claude") list.sort((a, b) => (b.name === "claude") - (a.name === "claude"));
  if (!list.length) {
    const err = new Error("no model provider configured");
    err.status = 503;
    throw err;
  }
  let first = null;
  for (let i = 0; i < list.length; i++) {
    try {
      const value = await list[i].run();
      return { value, provider: list[i].name, fallback: i ? { from: list[0].name, reason: String((first && first.status) || "network") } : null };
    } catch (err) {
      console.warn(`${list[i].name} failed${i < list.length - 1 ? ", falling back" : ""}:`, err && err.status, err && err.message);
      first = first || err;
      if (i === list.length - 1) throw err;
    }
  }
}

// opts.system: the tier's system prompt (agent.js systemFor). opts.models: the router's choice
// (router.js modelsFor); without it each provider uses its configured model, as before.
export async function runAgentWithFallback(opts) {
  const { env, fetchImpl = fetch, system = SYSTEM, models } = opts;
  const gemini = (model) => runAgent({ ...opts, fetchImpl, provider: geminiAgent(model ? { ...env, GEMINI_MODEL: model } : env, fetchImpl, system) });
  const claude = (model) => runAgent({ ...opts, fetchImpl, provider: claudeAgent(model ? { ...env, ANTHROPIC_MODEL: model } : env, fetchImpl, system) });
  const { value, fallback } = await withFallback(env, [
    { name: "gemini", ok: Boolean(env.GEMINI_API_KEY), run: () => gemini(models && models.gemini) },
    // Its own name, so the logs show which Gemini attempt failed.
    { name: "gemini-light", ok: Boolean(env.GEMINI_API_KEY && models && models.geminiFallback), run: () => gemini(models.geminiFallback) },
    { name: "claude", ok: Boolean(env.ANTHROPIC_API_KEY), run: withClaudeBudget(env, () => claude(models && models.claude)) },
  ]);
  if (fallback) value.usage.fallback = fallback;
  return value;
}
