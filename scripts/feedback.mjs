// Pulls visitor feedback from the live site and drafts eval cases from the thumbs-down answers.
//   FEEDBACK_ADMIN_TOKEN=... node scripts/feedback.mjs [--site https://hardyalsinghdeora.pages.dev] [--limit 200]
// Prints a summary and writes evals/results/feedback.json (every entry) and
// evals/results/feedback-candidates.json (drafts to finish and move into evals/answers.json).
// The token is the FEEDBACK_ADMIN_TOKEN secret set on the Pages project.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toEvalCandidates } from "../src/feedback.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const site = arg("--site", "https://hardyalsinghdeora.pages.dev").replace(/\/+$/, "");
const token = process.env.FEEDBACK_ADMIN_TOKEN;
if (!token) { console.error("FEEDBACK_ADMIN_TOKEN is not set"); process.exit(2); }

const res = await fetch(`${site}/api/feedback?limit=${encodeURIComponent(arg("--limit", "200"))}`, { headers: { authorization: "Bearer " + token } });
if (!res.ok) { console.error(`export failed: ${res.status} ${await res.text()}`); process.exit(1); }
const { entries } = await res.json();
const down = entries.filter((e) => e.rating === "down");
console.log(`${entries.length} ratings: ${entries.length - down.length} up, ${down.length} down`);
for (const e of down) console.log(`- ${e.ts.slice(0, 10)} "${e.question.slice(0, 90)}"${e.comment ? ` — ${e.comment}` : ""}`);

mkdirSync(join(root, "evals/results"), { recursive: true });
writeFileSync(join(root, "evals/results/feedback.json"), JSON.stringify(entries, null, 2));
writeFileSync(join(root, "evals/results/feedback-candidates.json"), JSON.stringify(toEvalCandidates(entries), null, 2));
console.log(`\nwrote evals/results/feedback.json and evals/results/feedback-candidates.json (${down.length} drafts)`);
