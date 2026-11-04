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
//     Questions with no key terms at all ("Who are you?") only ever match exactly.
//   - The owner can empty every namespace from /admin.html (clearCache), so one odd answer isn't
//     replayed for the whole TTL.
//   - Vectors are stored as int8 in base64 (about 1KB each instead of ~5KB of JSON floats), so the
//     one KV value per namespace stays small enough to parse on every cold isolate.
//
// Env: RATE_KV (required), SEMANTIC_CACHE=off, SEMANTIC_CACHE_THRESHOLD (cosine, default 0.92).

import { tokenize, embedQuery } from "./rag.js";

export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
export const CACHE_MAX_ENTRIES = 200;
export const DEFAULT_THRESHOLD = 0.92;
export const MIN_TERM_OVERLAP = 0.67; // "Kafka?" vs "Kafka, pirate voice?" is 0.5: no hit
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
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // both normalised: the query by rag.js, stored vectors by unpackVector
}

// Vector <-> base64 of one signed byte per dimension. Scaled by the largest component so the bytes
// use their full range (a unit 768-d vector's components are ~0.04); unpacking renormalises, so
// the scale needn't be stored.
export function packVector(v) {
  const bytes = new Uint8Array(v.length);
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const k = max ? 127 / max : 0;
  for (let i = 0; i < v.length; i++) bytes[i] = Math.round(v[i] * k) & 0xff;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function unpackVector(s) {
  const bin = atob(s);
  const v = new Array(bin.length);
  let n = 0;
  for (let i = 0; i < bin.length; i++) { const b = bin.charCodeAt(i); v[i] = b > 127 ? b - 256 : b; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
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
  // No key terms means no safe semantic match, so don't spend an embedding call on one.
  const terms = keyTerms(question);
  if (!entries.length || !terms.size || !env.GEMINI_API_KEY || env.RAG_EMBEDDINGS === "off") return { hit: null, vector: null };
  let vector;
  try {
    vector = await embedQuery(env, question, fetchImpl);
  } catch (err) {
    console.warn("semantic cache: no embedding, exact match only:", err && err.message);
    return { hit: null, vector: null };
  }
  const threshold = parseFloat(env.SEMANTIC_CACHE_THRESHOLD) || DEFAULT_THRESHOLD;
  let best = null, bestSim = -1;
  for (const e of entries) {
    if (typeof e.v !== "string" || termOverlap(terms, new Set(e.k)) < MIN_TERM_OVERLAP) continue;
    const sim = cosine(vector, unpackVector(e.v));
    if (sim >= threshold && sim > bestSim) { best = e; bestSim = sim; }
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
  const terms = keyTerms(question);
  if (!vector && terms.size && env.GEMINI_API_KEY && env.RAG_EMBEDDINGS !== "off") {
    try { vector = await embedQuery(env, question, fetchImpl); } catch { vector = null; }
  }
  const norm = normalizeQuestion(question);
  const entries = (await readEntries(env, key)).filter((e) => e.q !== norm);
  entries.push({
    q: norm, k: [...terms], t: Date.now(), a: text, m: meta,
    ...(vector && terms.size ? { v: packVector(vector) } : {}),
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

// Owner action (/api/admin/cache-clear): deletes every namespace, all tiers and versions.
// Returns how many KV keys were removed.
export async function clearCache(env) {
  memory.clear();
  const names = [];
  let cursor;
  do {
    const page = await env.RATE_KV.list({ prefix: "sc:", cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  await Promise.all(names.map((n) => env.RATE_KV.delete(n)));
  return names.length;
}

export function resetCacheMemory() {
  memory.clear();
}
