// Runtime output guard: the last check before model-written text reaches a visitor. The prompt
// already tells the model all of this; the guard is defence in depth for when it doesn't listen.
// The same patterns gate the knowledge base and public pages at build time (tests/index.html)
// and grade raw model output in the live evals (evals/harness.mjs).

// Any Indian mobile number (optionally +91-prefixed).
export const PHONE = /(?:\+91[-\s]?)?\b[6-9]\d{9}\b/;
// Redlines: text that may be said in an interview but never published. Only the generic part
// (rupee amounts, crore figures) lives here. The employer-internal names and company numbers
// (career-profile redlines.json and the verbal-only rows of the master résumé) are themselves
// private, so they come from the REDLINE_PATTERN secret, a regex alternation, and are never
// committed: the Worker reads it from env, CI from the repository secret, and local runs from the
// gitignored .redline-pattern file (scripts/redline-pattern.mjs).
const PUBLIC_REDLINES = String.raw`₹\s?\d|\bcr(ore)?\b`;
// Live binding: importers see the pattern configureRedlines() last compiled.
export let REDLINES = new RegExp(PUBLIC_REDLINES);
let redlineSource = null;
export function configureRedlines(pattern) {
  pattern = String(pattern || "").trim();
  if (pattern === redlineSource) return;
  REDLINES = new RegExp(pattern ? `(?:${pattern})|${PUBLIC_REDLINES}` : PUBLIC_REDLINES);
  redlineSource = pattern;
}
export const redlinesConfigured = () => Boolean(redlineSource);
// Compensation amounts: lakhs/LPA/crores, rupee or INR amounts, and salary-shaped dollar figures
// ($120k, $1,20,000, $150,000). Small dollar amounts such as an answer's cost ($0.0004) pass.
export const COMPENSATION = /\b\d+(?:\.\d+)?\s?(?:LPA|[Ll]akhs?|[Ll]acs?|[Cc]rores?)\b|₹\s?\d|\bINR\s?\d|\$\s?\d{1,3}(?:,\d{2,3})+\b|\$\s?\d+(?:\.\d+)?\s?[kKmM]\b/;

// A run of this many consecutive words copied from a prompt counts as a prompt leak. Long enough
// that an honest answer echoing a phrase ("happy to discuss it on a call") never trips it.
export const LEAK_WORDS = 12;
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const shingleCache = new Map();
function shingles(prompt) {
  if (!shingleCache.has(prompt)) {
    const w = words(prompt), set = new Set();
    for (let i = 0; i + LEAK_WORDS <= w.length; i++) set.add(w.slice(i, i + LEAK_WORDS).join(" "));
    shingleCache.set(prompt, set);
  }
  return shingleCache.get(prompt);
}

// Returns the reason text must not be shown ("redline", "redline_unconfigured", "phone",
// "compensation", "prompt_leak"), or null when it's fine. Without the private pattern the guard
// can't tell what is internal, so it fails closed for everyone who isn't an insider. prompts: system prompts whose wording must not be echoed back.
// tier (src/tiers.js) relaxes what the signed-in viewer may see: an approved recruiter may read
// internal names and company numbers but never compensation; the owner may read both. Phone
// numbers and prompt leaks are blocked for everyone.
export function guardText(text, prompts = [], tier = "public") {
  const s = String(text || "");
  const insider = tier === "recruiter" || tier === "owner";
  if (!insider && !redlinesConfigured()) return "redline_unconfigured";
  if (!insider && REDLINES.test(s)) return "redline";
  if (PHONE.test(s)) return "phone";
  if (tier !== "owner" && COMPENSATION.test(s)) return "compensation";
  if (prompts.length) {
    const w = words(s);
    for (let i = 0; i + LEAK_WORDS <= w.length; i++) {
      const sh = w.slice(i, i + LEAK_WORDS).join(" ");
      if (prompts.some((p) => shingles(p).has(sh))) return "prompt_leak";
    }
  }
  return null;
}

export const GUARDED_ANSWER = "That's not something I can share here. Email me at hardyalsinghdeora@gmail.com and I'll answer it myself.";
export const GUARDED_EVIDENCE = "Details withheld here; email me about this requirement.";
