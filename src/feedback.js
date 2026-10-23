// Visitor feedback on answers: a thumbs up or down, and an optional note on what was wrong.
// Each answer carries a signature (meta.fb) over the question and the answer text, made with a
// server-side secret, and feedback is accepted only with a matching one. So the store holds
// ratings of answers the site actually gave, not text anyone can post, which matters because
// thumbs-down entries become draft eval cases (scripts/feedback.mjs).

export const FEEDBACK_TTL = 60 * 60 * 24 * 90;   // seconds; entries expire after 90 days
export const MAX_COMMENT = 300;
const MAX_ANSWER = 4000;
const MAX_QUESTION = 1000;

// FEEDBACK_SECRET when set; otherwise derived from an API key, which never leaves the server.
function secretOf(env) {
  return env.FEEDBACK_SECRET || env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY || "";
}

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparison that takes the same time wherever the strings first differ.
export function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// null when no secret is available; the page then shows no feedback buttons.
export async function feedbackToken(env, question, answer) {
  const secret = secretOf(env);
  return secret ? hmacHex("feedback:" + secret, String(question) + "\u0000" + String(answer)) : null;
}

const clip = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");

// Validates a POST body. Returns { entry } or { error }. Diagnostic fields (sources, retrieval,
// model) come from the page and aren't signed; they help triage and change nothing else.
export async function feedbackEntry(env, body, now = new Date()) {
  if (!body || (body.rating !== "up" && body.rating !== "down")) return { error: "bad_rating" };
  const question = clip(body.question, MAX_QUESTION), answer = clip(body.answer, MAX_ANSWER + 1);
  if (!question || !answer || answer.length > MAX_ANSWER) return { error: "bad_answer" };
  const token = await feedbackToken(env, question, answer);
  if (!token || !sameToken(token, body.token)) return { error: "bad_token" };
  const ids = Array.isArray(body.sources) ? body.sources.filter((s) => typeof s === "string").slice(0, 8).map((s) => s.slice(0, 80)) : [];
  return {
    entry: {
      ts: now.toISOString(),
      rating: body.rating,
      question,
      answer,
      comment: body.rating === "down" ? clip(body.comment, MAX_COMMENT) : "",
      sources: ids,
      retrieval: clip(body.retrieval, 20),
      model: clip(body.model, 60),
      fallback: Boolean(body.fallback),
    },
  };
}

// KV key: ISO timestamp first, so a prefix listing comes back oldest first.
export function feedbackKey(entry) {
  return `fb:${entry.ts}:${Math.random().toString(36).slice(2, 8)}`;
}

// Thumbs-down entries as draft answer-eval cases. The checks are left for a person to write:
// the visitor's note says what was wrong, not what the right answer is.
export function toEvalCandidates(entries) {
  return entries.filter((e) => e.rating === "down").map((e, i) => ({
    id: `fb-${e.ts.slice(0, 10)}-${i + 1}`,
    category: "feedback",
    q: e.question,
    TODO: "Add any / all / none / sources checks from what the right answer must contain, then move into evals/answers.json.",
    visitor_comment: e.comment || null,
    answer_given: e.answer,
    sources_seen: e.sources,
    model: e.model,
  }));
}
