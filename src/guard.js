// Runtime output guard: the last check before model-written text reaches a visitor. The prompt
// already tells the model all of this; the guard is defence in depth for when it doesn't listen.
// The same patterns gate the knowledge base and public pages at build time (tests/index.html)
// and grade raw model output in the live evals (evals/harness.mjs).

// Any Indian mobile number (optionally +91-prefixed).
export const PHONE = /(?:\+91[-\s]?)?\b[6-9]\d{9}\b/;
// Employer-internal vocabulary and company numbers that may be said in an interview but never
// published (career-profile redlines.json and the verbal-only rows of the master résumé).
export const REDLINES = /\b(Mindspark|Naandi|Shiksha|SchoolSite|School Site|Navigator|da_orderMaster|common_user_details|educatio_educat|ei-order|navigator-aggregator|ei-navigator-ui|ei-mcp-gateway|Zoho)\b|\b(ASSET|CARES|SZM|NSH)\b|\bNAV-\d|500k|500,000|577|1,689,499|363,609|₹\s?\d|\bcr(ore)?\b/;
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

// Returns the reason text must not be shown ("redline", "phone", "compensation", "prompt_leak"),
// or null when it's fine. prompts: system prompts whose wording must not be echoed back.
export function guardText(text, prompts = []) {
  const s = String(text || "");
  if (REDLINES.test(s)) return "redline";
  if (PHONE.test(s)) return "phone";
  if (COMPENSATION.test(s)) return "compensation";
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
