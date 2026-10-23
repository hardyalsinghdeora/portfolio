// Runs the eval sets against the live Gemini API and writes a scorecard. Not part of npm test:
// it costs real calls and the model is non-deterministic, so it runs nightly in CI
// (.github/workflows/evals.yml) and on demand.
//
//   GEMINI_API_KEY=... node scripts/eval.mjs                 full run
//   GEMINI_API_KEY=... node scripts/eval.mjs --only salary   answer cases whose id matches
//
// Optional env: GEMINI_MODEL, EVAL_JUDGE_MODEL, ANTHROPIC_API_KEY / ANTHROPIC_MODEL / LLM_PRIMARY=claude, GEMINI_PRICE_INPUT / GEMINI_PRICE_OUTPUT (USD per
// 1M tokens), EVAL_DELAY_MS (pause between cases, default 4000 for free-tier rate limits).
// Writes evals/results/latest.json and evals/results/scorecard.md, appends the scorecard to
// $GITHUB_STEP_SUMMARY when set, and exits 1 on any safety failure or job-fit overclaim.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvals, scorecardMarkdown, failed } from "../evals/harness.mjs";
import { DEFAULT_MODEL } from "../src/agent.js";
import { CLAUDE_DEFAULT_MODEL } from "../src/providers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(2);
}
const i = process.argv.indexOf("--only");
const only = i > 0 ? new RegExp(process.argv[i + 1], "i") : null;
const env = Object.fromEntries(["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_EMBED_MODEL", "EVAL_JUDGE_MODEL",
  "GEMINI_PRICE_INPUT", "GEMINI_PRICE_OUTPUT", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "LLM_PRIMARY"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

const started = Date.now();
const { answers, fits, summary } = await runEvals({
  answerSet: json("evals/answers.json"),
  fitSet: json("evals/fit.json"),
  retrievalSets: { "recruiter questions": json("tests/evals.json"), "hard paraphrases": json("evals/retrieval-hard.json") },
  env,
  fetchImpl: fetch,
  delayMs: parseInt(process.env.EVAL_DELAY_MS || "4000", 10),
  only,
  log: (line) => console.log(line),
});

const model = env.LLM_PRIMARY === "claude" ? env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL : env.GEMINI_MODEL || DEFAULT_MODEL;
const date = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
const md = scorecardMarkdown(summary, { model, date });
mkdirSync(join(root, "evals/results"), { recursive: true });
writeFileSync(join(root, "evals/results/latest.json"), JSON.stringify({ date, model, ms: Date.now() - started, summary, answers, fits }, null, 2));
writeFileSync(join(root, "evals/results/scorecard.md"), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log("\n" + md);
process.exit(failed(summary) ? 1 : 0);
