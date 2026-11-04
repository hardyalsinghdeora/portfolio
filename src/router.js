// Model router: send each question to the cheapest model that can answer it well.
// Most portfolio questions are lookups ("notice period?", "do you know Postgres?") that a small
// model answers from the retrieved passages as well as a large one. Design, trade-off and
// multi-part questions go to the stronger model. Rules, not a model call: classifying with an LLM
// would cost about as much as the cheap answer it is meant to save.
//
// Env (all optional):
//   GEMINI_MODEL_LIGHT    default GEMINI_MODEL, then the agent's DEFAULT_MODEL
//   GEMINI_MODEL_HEAVY    default: the light model, so Gemini routing stays off until this is set
//   ANTHROPIC_MODEL_LIGHT default claude-haiku-5-5
//   ANTHROPIC_MODEL       heavy Claude model, default claude-opus-5-5 (src/providers.js)
//   MODEL_ROUTER=off      always use the heavy models

import { DEFAULT_MODEL } from "./agent.js";
import { CLAUDE_DEFAULT_MODEL } from "./providers.js";

export const CLAUDE_LIGHT_MODEL = "claude-haiku-5-5";

const HEAVY = /\b(design|architect\w*|trade-?offs?|compare|comparison|versus|vs\.?|difference between|pros and cons|why (?:did|would|do) you|how would you|walk me through|deep dive|step by step|explain (?:how|why)|approach(?:es)? to|strateg\w+|scal(?:e|ing|ability)|failure modes?|incident|debug\w*|evaluat\w+|migrat\w+ plan)\b/i;
const LIGHT = /\b(email|contact|reach you|linkedin|github|resume|cv|notice|join|available|availability|location|based|relocat\w*|remote|hybrid|hello|hi|hey|thanks|thank you|who are you|how many years|years of experience|current (?:role|company|title)|education|degree|certifications?)\b/i;
const HEAVY_WORDS = 35;
const LIGHT_WORDS = 12;
const DEEP_CONVERSATION = 5; // turns; long follow-up chains get the stronger model

// turns: the screened conversation. Returns { level: "light" | "heavy", reason }.
export function routeQuestion(turns, { kind = "ask" } = {}) {
  if (kind === "fit") return { level: "heavy", reason: "job_fit" };
  const q = String((turns[turns.length - 1] || {}).content || "");
  const words = q.split(/\s+/).filter(Boolean).length;
  if (HEAVY.test(q)) return { level: "heavy", reason: "complex_intent" };
  if (words > HEAVY_WORDS) return { level: "heavy", reason: "long_question" };
  if ((q.match(/\?/g) || []).length >= 2) return { level: "heavy", reason: "multi_part" };
  if (turns.length >= DEEP_CONVERSATION) return { level: "heavy", reason: "deep_follow_up" };
  if (LIGHT.test(q)) return { level: "light", reason: "simple_lookup" };
  if (words <= LIGHT_WORDS) return { level: "light", reason: "short_question" };
  return { level: "light", reason: "default" };
}

// The concrete model per provider for a route level.
export function modelsFor(env, level) {
  const geminiLight = env.GEMINI_MODEL_LIGHT || env.GEMINI_MODEL || DEFAULT_MODEL;
  const geminiHeavy = env.GEMINI_MODEL_HEAVY || geminiLight;
  const claudeLight = env.ANTHROPIC_MODEL_LIGHT || CLAUDE_LIGHT_MODEL;
  const claudeHeavy = env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL;
  const heavy = level === "heavy" || env.MODEL_ROUTER === "off";
  return {
    gemini: heavy ? geminiHeavy : geminiLight,
    // A heavy Gemini model that fails (quota, or a model name the account can't use) falls back
    // to the light one before Claude.
    geminiFallback: heavy && geminiHeavy !== geminiLight ? geminiLight : null,
    claude: heavy ? claudeHeavy : claudeLight,
  };
}
