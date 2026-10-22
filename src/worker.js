// Cloudflare Pages advanced-mode worker. Serves the static site and three endpoints:
//   POST /api/ask     the portfolio agent (Gemini function calling + hybrid RAG)
//   POST /api/fit     job-description fit: { jd } -> requirement-by-requirement match with sources
//   GET  /api/search  retrieval only, no LLM call: ?q=... returns the top passages
//
// Secret:   GEMINI_API_KEY (Pages project > Settings > Variables and Secrets)
// Optional: GEMINI_MODEL, GEMINI_EMBED_MODEL, RAG_EMBEDDINGS=off (BM25 only),
//           RATE_KV (KV binding: per-IP hourly limit, an embedding cache, and visit-source counts),
//           USAGE_AE (Workers Analytics Engine binding: one data point per answer, for cost and latency),
//           GEMINI_PRICE_INPUT / GEMINI_PRICE_OUTPUT (USD per 1M tokens, to report cost)
//
// Response format of /api/ask: the answer as plain text, then the record separator U+001E,
// then a JSON object { sources, steps, retrieval }. Older pages simply show the text part.

import { PROFILE } from "./knowledge.js";
import { buildChunks, buildIndex, search } from "./rag.js";
import { runAgent, SYSTEM } from "./agent.js";
import { guardText, GUARDED_ANSWER, GUARDED_EVIDENCE } from "./guard.js";
import { assessFit, JD_MIN, JD_MAX } from "./fit.js";

const MAX_TURNS = 10;          // matches the page, which keeps the last 10 turns
const MAX_CHARS = 1000;        // per message
const HOURLY_LIMIT = 30;       // questions per IP per hour, only when RATE_KV is bound
export const SEP = "\u001e";

// Sources counted from ?ref= links (docs/listings.md hands these out). Anything else is ignored,
// so a crafted ref can't create KV keys or spend the daily write budget.
export const SOURCES = ["linkedin", "naukri", "github", "resume", "email"];
const BOT = /bot|crawl|spider|preview|facebookexternalhit|slack|whatsapp|telegram|discord|embedly|curl|wget|python-requests/i;

let INDEX = null;
export function getIndex() {
  return INDEX || (INDEX = buildIndex(buildChunks(PROFILE)));
}

export default {
  fetch: (request, env) => handle(request, env, fetch),
};

// Short, stable links the agent can quote without mangling a long GitHub URL.
export const SHORT_LINKS = {
  "/case/php-to-node": "https://github.com/hardyalsinghdeora/portfolio/blob/main/docs/case-study-php-to-node-strangler.md",
  "/case/db-migration": "https://github.com/hardyalsinghdeora/case-studies/blob/main/migration-live-commerce-platform.md",
  "/source": "https://github.com/hardyalsinghdeora/portfolio",
};

// fetchImpl is injectable so tests can stand in for the Gemini API.
export async function handle(request, env, fetchImpl) {
  const url = new URL(request.url);
  const target = SHORT_LINKS[url.pathname.replace(/\/+$/, "")];
  if (target) return Response.redirect(target, 302);
  try {
    if (url.pathname === "/api/ask") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return await ask(request, env, fetchImpl);
    }
    if (url.pathname === "/api/fit") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return await fit(request, env, fetchImpl);
    }
    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      return await searchOnly(request, env, url, fetchImpl);
    }
  } catch (err) {
    console.error("api crashed", err && err.message);
    return json(500, { error: "server" });
  }
  if (request.method === "GET" && url.pathname === "/") await countSource(env, request, "visit", url.searchParams.get("ref"));
  return env.ASSETS.fetch(request);
}

async function ask(request, env, fetchImpl) {
  if (!sameOrigin(request)) return json(403, { error: "forbidden" });
  if (!env.GEMINI_API_KEY) return json(503, { error: "not_configured" });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "bad_json" }); }
  const turns = validTurns(body && body.messages);
  if (!turns) return json(400, { error: "bad_messages" });
  if (env.RATE_KV && !(await underLimit(env.RATE_KV, request))) return json(429, { error: "rate_limited" });

  let result;
  try {
    result = await runAgent({ turns, index: getIndex(), profile: PROFILE, env, fetchImpl });
  } catch (err) {
    console.error("agent failed", err && err.status, err && err.detail);
    // Free-tier quota exhaustion comes back as 429; the page shows its "busy" note.
    return json(err && err.status === 429 ? 429 : 502, { error: "upstream" });
  }
  await countSource(env, request, "ask", body.ref);
  // Last check before the visitor sees it. The model's text is dropped, never logged.
  const guard = guardText(result.text, [SYSTEM]);
  if (guard) console.warn(JSON.stringify({ event: "guard", kind: "ask", reason: guard }));
  recordUsage(env, "ask", result.usage, result.retrieval, body.ref, guard);
  const meta = guard
    ? { sources: [], steps: result.steps, retrieval: result.retrieval, usage: result.usage, guarded: true }
    : { sources: result.sources, steps: result.steps, retrieval: result.retrieval, usage: result.usage };
  return new Response((guard ? GUARDED_ANSWER : result.text) + SEP + JSON.stringify(meta), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function fit(request, env, fetchImpl) {
  if (!sameOrigin(request)) return json(403, { error: "forbidden" });
  if (!env.GEMINI_API_KEY) return json(503, { error: "not_configured" });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "bad_json" }); }
  const jd = typeof (body && body.jd) === "string" ? body.jd.trim() : "";
  if (jd.length < JD_MIN) return json(400, { error: "jd_too_short", min: JD_MIN });
  if (jd.length > JD_MAX) return json(400, { error: "jd_too_long", max: JD_MAX });
  if (env.RATE_KV && !(await underLimit(env.RATE_KV, request))) return json(429, { error: "rate_limited" });

  let result;
  try {
    result = await assessFit({ jd, index: getIndex(), env, fetchImpl });
  } catch (err) {
    console.error("fit failed", err && err.status, err && err.detail);
    return json(err && err.status === 429 ? 429 : 502, { error: "upstream" });
  }
  // The description itself is never stored or logged.
  // Guard the model-written fields. Requirement text is the visitor's own job description
  // paraphrased back to them, so it isn't checked.
  let guard = null;
  for (const r of result.requirements) {
    const g = guardText(r.evidence);
    if (g) { guard = guard || g; r.evidence = GUARDED_EVIDENCE; }
  }
  const g = guardText(result.summary);
  if (g) { guard = guard || g; result.summary = GUARDED_ANSWER; }
  if (guard) { result.guarded = true; console.warn(JSON.stringify({ event: "guard", kind: "fit", reason: guard })); }
  await countSource(env, request, "fit", body.ref);
  recordUsage(env, "fit", result.usage, result.retrieval, body.ref, guard);
  return json(200, result);
}

async function searchOnly(request, env, url, fetchImpl) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
  if (!q) return json(400, { error: "missing_q" });
  if (env.RATE_KV && !(await underLimit(env.RATE_KV, request))) return json(429, { error: "rate_limited" });
  const k = Math.min(8, Math.max(1, parseInt(url.searchParams.get("k") || "5", 10) || 5));
  const { mode, hits } = await search(getIndex(), q, { k, env, fetchImpl });
  return json(200, { query: q, retrieval: mode, hits: hits.map(({ id, title, section, score, text }) => ({ id, title, section, score, text })) });
}

export function validTurns(list) {
  if (!Array.isArray(list)) return null;
  list = list.slice(-MAX_TURNS);
  // The page trims history to the last N turns, which can leave an assistant turn first.
  while (list.length && list[0] && list[0].role === "assistant") list = list.slice(1);
  if (list.length === 0 || list.length % 2 === 0) return null;
  const turns = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const role = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== role || typeof m.content !== "string") return null;
    const content = m.content.trim().slice(0, MAX_CHARS);
    if (!content) return null;
    turns.push({ role, content });
  }
  return turns;
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

// Fails open: if KV is down or past the free plan's daily write cap, answering unmetered
// beats failing every visitor until the cap resets.
async function underLimit(kv, request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `ask:${ip}:${Math.floor(Date.now() / 3600000)}`;
  try {
    const n = parseInt((await kv.get(key)) || "0", 10);
    if (n >= HOURLY_LIMIT) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 3700 });
  } catch (err) {
    console.warn("rate limit unavailable, allowing request:", err && err.message);
  }
  return true;
}

// Monthly counters per source, e.g. "ref:visit:linkedin:2026-10" -> "17". Read them in the KV
// namespace in the Cloudflare dashboard. A lost increment under concurrency is fine at this scale.
// Fails open like the rate limit: counting must never break the page.
export async function countSource(env, request, kind, ref) {
  if (!env.RATE_KV || !SOURCES.includes(ref)) return;
  if (BOT.test(request.headers.get("user-agent") || "")) return;
  const key = `ref:${kind}:${ref}:${new Date().toISOString().slice(0, 7)}`;
  try {
    const n = parseInt((await env.RATE_KV.get(key)) || "0", 10);
    await env.RATE_KV.put(key, String(n + 1));
  } catch (err) {
    console.warn("source count failed:", err && err.message);
  }
}

// One structured log line per answer (visible in the Pages real-time logs), plus a data point in
// Workers Analytics Engine when USAGE_AE is bound. Neither touches KV, so tracking costs no writes.
// Query: SELECT blob1 AS kind, quantileWeighted(0.5)(double1, _sample_interval) AS p50_ms,
//        SUM(double2 * _sample_interval) AS input_tokens ... FROM <dataset> GROUP BY kind
export function recordUsage(env, kind, usage, retrieval, ref, guard) {
  if (!usage) return;
  console.log(JSON.stringify({ event: kind, model: usage.model, calls: usage.calls, ms: usage.ms,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: usage.cost_usd, retrieval, guard: guard || null }));
  try {
    if (env.USAGE_AE) env.USAGE_AE.writeDataPoint({
      indexes: [kind],
      blobs: [kind, usage.model, retrieval || "none", SOURCES.includes(ref) ? ref : "", guard || ""],
      doubles: [usage.ms, usage.input_tokens, usage.output_tokens, usage.calls, usage.cost_usd || 0],
    });
  } catch (err) {
    console.warn("usage data point failed:", err && err.message);
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
