// Access tiers: what each kind of visitor may see.
//   public     anyone
//   member     signed in with LinkedIn, not (yet) approved
//   recruiter  a member the owner approved in /admin.html
//   owner      Hardyal (OWNER_EMAILS)
// The tier comes only from the signed session (src/auth.js), never from anything typed into the
// chat. Private passages are never in the repo or the bundle: scripts/private-kb.mjs uploads them
// to KV, and they join the retrieval index only for the tiers allowed to read them. So the model
// can't leak what it was never shown.

import { buildChunks, buildIndex } from "./rag.js";

export const TIERS = ["public", "member", "recruiter", "owner"];
export function tierAtLeast(tier, min) {
  return TIERS.indexOf(tier) >= TIERS.indexOf(min);
}

// KV keys each tier may read. The owner also reads the recruiter passages.
export const PRIVATE_KEYS = { recruiter: ["kb:recruiter"], owner: ["kb:recruiter", "kb:owner"] };
const PRIVATE_REFRESH_MS = 60000;
export const MAX_PRIVATE_PASSAGES = 80;
const MAX_PASSAGE_CHARS = 2400;

const privateDocs = new Map();   // KV key -> { at, doc }
const tierIndexes = new Map();   // tier -> { version, index }

// { version, passages: [{ id, title, text }] } -> chunks. Malformed passages are skipped, not fatal.
export function privateChunks(doc, level) {
  const passages = doc && Array.isArray(doc.passages) ? doc.passages.slice(0, MAX_PRIVATE_PASSAGES) : [];
  return passages
    .filter((p) => p && typeof p.id === "string" && typeof p.title === "string" && typeof p.text === "string" && p.text.trim())
    .map((p) => ({
      id: `${level}-${p.id}`,
      title: p.title,
      section: "private_details",
      text: (p.title + "\n" + p.text).slice(0, MAX_PASSAGE_CHARS),
    }));
}

async function readPrivate(env, key) {
  const cached = privateDocs.get(key);
  if (cached && Date.now() - cached.at < PRIVATE_REFRESH_MS) return cached.doc;
  let doc = null;
  try {
    doc = env.RATE_KV ? await env.RATE_KV.get(key, "json") : null;
  } catch (err) {
    console.warn("private knowledge unavailable:", key, err && err.message);
    if (cached) return cached.doc;
  }
  privateDocs.set(key, { at: Date.now(), doc });
  return doc;
}

// Cheap, synchronous content hash (FNV-1a) used to version indexes and the semantic cache, so an
// edited profile or private upload never serves answers built from the old text.
export function contentVersion(parts) {
  let h = 0x811c9dc5;
  for (const s of parts) {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x1e; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// The index a tier searches: the public profile, plus the private passages that tier may read.
// publicIndex is the shared public index (src/worker.js builds it once per isolate).
export async function indexForTier(env, tier, publicIndex) {
  if (!publicIndex.version) publicIndex.version = contentVersion(publicIndex.chunks.map((c) => c.text));
  const keys = PRIVATE_KEYS[tier];
  if (!keys) return publicIndex;
  const extra = [];
  for (const key of keys) extra.push(...privateChunks(await readPrivate(env, key), key.slice(3)));
  if (!extra.length) return publicIndex;
  const version = publicIndex.version + ":" + contentVersion(extra.map((c) => c.text));
  const hit = tierIndexes.get(tier);
  if (hit && hit.version === version) return hit.index;
  const index = buildIndex(publicIndex.chunks.concat(extra));
  index.version = version;
  tierIndexes.set(tier, { version, index });
  return index;
}

// Tests reset the per-isolate caches between cases.
export function resetTierCaches() {
  privateDocs.clear();
  tierIndexes.clear();
}

// For callers that hold a profile rather than an index (the tests and the eval harness).
export function publicIndexOf(profile) {
  return buildIndex(buildChunks(profile));
}
