// Validates the private knowledge files and uploads them to KV, where src/tiers.js reads them.
// They live in knowledge/private/ (gitignored): never commit them, and never put them in
// knowledge/profile.json, which is public and bundled into the site.
//
//   knowledge/private/recruiter.json   approved recruiters and the owner
//   knowledge/private/owner.json       the owner only
//
// Format (see knowledge/private.example.json): { "passages": [{ "id", "title", "text" }] }
//
// Usage:
//   node scripts/private-kb.mjs            validate only
//   KV_NAMESPACE_ID=<id> node scripts/private-kb.mjs --upload
//                                          validate, then upload with wrangler (needs `npx wrangler login`)
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PHONE, COMPENSATION } from "../src/guard.js";
import { MAX_PRIVATE_PASSAGES } from "../src/tiers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  { level: "recruiter", key: "kb:recruiter", path: "knowledge/private/recruiter.json" },
  { level: "owner", key: "kb:owner", path: "knowledge/private/owner.json" },
];

// Returns a list of problems; empty means the file is fine for its level.
export function validatePrivate(doc, level) {
  const problems = [];
  if (!doc || !Array.isArray(doc.passages)) return ["missing a passages array"];
  if (doc.passages.length > MAX_PRIVATE_PASSAGES) problems.push(`more than ${MAX_PRIVATE_PASSAGES} passages`);
  const ids = new Set();
  doc.passages.forEach((p, i) => {
    const at = `passage ${i + 1}${p && p.id ? ` (${p.id})` : ""}`;
    if (!p || typeof p.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(p.id)) problems.push(`${at}: id must be 2-40 chars of a-z, 0-9 and -`);
    else if (ids.has(p.id)) problems.push(`${at}: duplicate id`);
    else ids.add(p.id);
    if (!p || typeof p.title !== "string" || p.title.length < 4) problems.push(`${at}: title missing`);
    if (!p || typeof p.text !== "string" || p.text.length < 20) problems.push(`${at}: text missing`);
    const text = `${p && p.title} ${p && p.text}`;
    if (PHONE.test(text)) problems.push(`${at}: contains a phone number (never stored, at any level)`);
    // Recruiters must never see compensation: the guard would block it anyway, but it should not
    // reach the model at all.
    if (level === "recruiter" && COMPENSATION.test(text)) problems.push(`${at}: compensation figures belong in owner.json`);
    if (/\[FILL/i.test(text)) problems.push(`${at}: still has a [FILL] placeholder`);
  });
  return problems;
}

function main() {
  const upload = process.argv.includes("--upload");
  let failed = false;
  const ready = [];
  for (const f of FILES) {
    const file = join(root, f.path);
    if (!existsSync(file)) { console.log(`skip ${f.path} (not found)`); continue; }
    let doc;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`FAIL ${f.path}: invalid JSON: ${e.message}`); failed = true; continue; }
    const problems = validatePrivate(doc, f.level);
    if (problems.length) { failed = true; for (const p of problems) console.error(`FAIL ${f.path}: ${p}`); continue; }
    console.log(`ok   ${f.path}: ${doc.passages.length} passages for the ${f.level} tier`);
    ready.push({ ...f, doc });
  }
  if (failed) process.exit(1);
  if (!upload) { console.log("\nValidated only. Add --upload (with KV_NAMESPACE_ID set) to push to KV."); return; }
  const ns = process.env.KV_NAMESPACE_ID;
  if (!ns) { console.error("Set KV_NAMESPACE_ID to the RATE_KV namespace id (Cloudflare dashboard > Workers & Pages > KV)."); process.exit(1); }
  const tmp = mkdtempSync(join(tmpdir(), "private-kb-"));
  try {
    for (const f of ready) {
      const out = join(tmp, f.level + ".json");
      writeFileSync(out, JSON.stringify({ version: new Date().toISOString(), passages: f.doc.passages }));
      const r = spawnSync("npx", ["wrangler", "kv", "key", "put", f.key, "--path", out, "--namespace-id", ns, "--remote"],
        { stdio: "inherit", shell: process.platform === "win32" });
      if (r.status !== 0) { console.error(`upload of ${f.key} failed`); process.exit(1); }
      console.log(`uploaded ${f.key}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("Done. Signed-in tiers see the new passages within about a minute.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
