// Semantic answer cache: a repeated question is answered from KV with no model call.
// Recruiters ask the same dozen things ("notice period?", "do you know Postgres?"), so a cache in
// front of the agent cuts both cost and latency.
//
// Safety rules:
//   - One namespace per tier and content version: a recruiter's answer (which may name internal
//     systems) is never served to a public visitor, and an edited profile or system prompt starts
//     an empty cache. The owner tier isn't cached at all.
//   - Only first questions are cached. A follow-up depends on the conversation before it.
//   - Only grounded answers are stored: answers that cited sources and passed the output guard.
//   - A semantic hit needs both a close embedding (cosine) and the same key terms (Jaccard over
//     tokens), because "Do you know Kafka?" and "Do you know Kubernetes?" embed close together.
//
// Env: RATE_KV (required), SEMANTIC_CACHE=off, SEMANTIC_CACHE_THRESHOLD (cosine, default 0.92).

import { tokenize, embedQuery } from "./rag.js";

export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
export const CACHE_MAX_ENTRIES = 200;
export const DEFAULT_THRESHOLD = 0.92;
export const MIN_TERM_OVERLAP = 0.5;
const MEMORY_REFRESH_MS = 30000;
const memory = new Map(); // KV key -> { at, entries }

export function cacheEnabled(env, tier) {
  return Boolean(env.RATE_KV) && env.SEMANTIC_CACHE !== "off" && tier !== "owner";
}

export function normalizeQuestion(q) {
  return String(q || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Words that carry no topic, on top of the retrieval stop list.
const FILLER = new Set(["know", "hardyal", "experience", "work", "worked", "used", "please", "could", "would", "much", "many", "ever", "done"]);
export function keyTerms(q) {
  return new Set(tokenize(q).filter((t) => !FILLER.has(t)));
}

export function termOverlap(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalised by rag.js
}

export function cacheKey(tier, version) {
  return `sc:${tier}:${version}`;
}

async function readEntries(env, key) {
  const m = memory.get(key);
  if (m && Date.now() - m.at < MEMORY_REFRESH_MS) return m.entries;
  let entries = [];
  try {
    const doc = await env.RATE_KV.get(key, "json");
    entries = doc && Array.isArray(doc.entries) ? doc.entries : [];
  } catch (err) {
    console.warn("semantic cache unavailable:", err && err.message);
    if (m) return m.entries;
  }
  const now = Date.now();
  entries = entries.filter((e) => now - e.t < CACHE_TTL_MS);
  memory.set(key, { at: now, entries });
  return entries;
}

// Returns { hit, vector }. hit is { text, meta, kind: "exact" | "semantic", similarity } or null.
// vector is the question's embedding when one was computed, so cacheStore can reuse it.
export async function cacheLookup({ env, tier, version, question, fetchImpl }) {
  if (!cacheEnabled(env, tier)) return { hit: null, vector: null };
  const entries = await readEntries(env, cacheKey(tier, version));
  const norm = normalizeQuestion(question);
  const exact = entries.find((e) => e.q === norm);
  if (exact) return { hit: { text: exact.a, meta: exact.m, kind: "exact", similarity: 1 }, vector: null };
  if (!entries.length || !env.GEMINI_API_KEY || env.RAG_EMBEDDINGS === "off") return { hit: null, vector: null };
  let vector;
  try {
    vector = await embedQuery(env, question, fetchImpl);
  } catch (err) {
    console.warn("semantic cache: no embedding, exact match only:", err && err.message);
    return { hit: null, vector: null };
  }
  const threshold = parseFloat(env.SEMANTIC_CACHE_THRESHOLD) || DEFAULT_THRESHOLD;
  const terms = keyTerms(question);
  let best = null, bestSim = -1;
  for (const e of entries) {
    if (!e.v) continue;
    const sim = cosine(vector, e.v);
    if (sim >= threshold && sim > bestSim && termOverlap(terms, new Set(e.k)) >= MIN_TERM_OVERLAP) { best = e; bestSim = sim; }
  }
  if (!best) return { hit: null, vector };
  return { hit: { text: best.a, meta: best.m, kind: "semantic", similarity: +bestSim.toFixed(4) }, vector };
}

// Stores one answer. meta must not hold per-visitor fields (the feedback token is added per reply).
// A lost write under concurrency only means one extra model call later.
export async function cacheStore({ env, tier, version, question, vector, text, meta, fetchImpl = fetch }) {
  if (!cacheEnabled(env, tier)) return false;
  const key = cacheKey(tier, version);
  // The lookup skips embedding when the cache is empty, so the first answers arrive without a
  // vector. Embed now, or they could only ever match exactly.
  if (!vector && env.GEMINI_API_KEY && env.RAG_EMBEDDINGS !== "off") {
    try { vector = await embedQuery(env, question, fetchImpl); } catch { vector = null; }
  }
  const norm = normalizeQuestion(question);
  const entries = (await readEntries(env, key)).filter((e) => e.q !== norm);
  entries.push({
    q: norm, k: [...keyTerms(question)], t: Date.now(), a: text, m: meta,
    ...(vector ? { v: vector.map((x) => Math.round(x * 1e4) / 1e4) } : {}),
  });
  const kept = entries.slice(-CACHE_MAX_ENTRIES);
  memory.set(key, { at: Date.now(), entries: kept });
  try {
    await env.RATE_KV.put(key, JSON.stringify({ entries: kept }), { expirationTtl: Math.ceil(CACHE_TTL_MS / 1000) + 86400 });
    return true;
  } catch (err) {
    console.warn("semantic cache not stored:", err && err.message);
    return false;
  }
}

export function resetCacheMemory() {
  memory.clear();
}
