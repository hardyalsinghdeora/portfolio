// Cloudflare Pages advanced-mode worker. Serves the static site and two endpoints:
//   POST /api/ask     the portfolio agent (Gemini function calling + hybrid RAG)
//   GET  /api/search  retrieval only, no LLM call: ?q=... returns the top passages
//
// Secret:   GEMINI_API_KEY (Pages project > Settings > Variables and Secrets)
// Optional: GEMINI_MODEL, GEMINI_EMBED_MODEL, RAG_EMBEDDINGS=off (BM25 only),
//           RATE_KV (KV binding: per-IP hourly limit and an embedding cache)
//
// Response format of /api/ask: the answer as plain text, then the record separator U+001E,
// then a JSON object { sources, steps, retrieval }. Older pages simply show the text part.

import { PROFILE } from "./knowledge.js";
import { buildChunks, buildIndex, search } from "./rag.js";
import { runAgent } from "./agent.js";

const MAX_TURNS = 10;          // matches the page, which keeps the last 10 turns
const MAX_CHARS = 1000;        // per message
const HOURLY_LIMIT = 30;       // questions per IP per hour, only when RATE_KV is bound
export const SEP = "\u001e";

let INDEX = null;
export function getIndex() {
  return INDEX || (INDEX = buildIndex(buildChunks(PROFILE)));
}

export default {
  fetch: (request, env) => handle(request, env, fetch),
};

// fetchImpl is injectable so tests can stand in for the Gemini API.
export async function handle(request, env, fetchImpl) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/ask") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return await ask(request, env, fetchImpl);
    }
    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      return await searchOnly(request, env, url, fetchImpl);
    }
  } catch (err) {
    console.error("api crashed", err && err.message);
    return json(500, { error: "server" });
  }
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
  const meta = { sources: result.sources, steps: result.steps, retrieval: result.retrieval };
  return new Response(result.text + SEP + JSON.stringify(meta), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
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

async function underLimit(kv, request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `ask:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = parseInt((await kv.get(key)) || "0", 10);
  if (n >= HOURLY_LIMIT) return false;
  await kv.put(key, String(n + 1), { expirationTtl: 3700 });
  return true;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
