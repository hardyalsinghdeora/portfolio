// Headless test run for CI and local use: serves the repo, opens tests/index.html in Chromium,
// waits for window.__TESTS__, then smoke-tests the bundled dist/_worker.js in Node.
// Exits non-zero on any failure. Usage: node scripts/test.mjs (after node scripts/build.mjs)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/tests/");
  await page.waitForFunction(() => window.__TESTS__, null, { timeout: 30000 }).catch(() => {});
  const r = await page.evaluate(() => window.__TESTS__);
  if (!r) {
    console.error("test page never finished", errors);
    failed++;
  } else {
    console.log(`unit + agent tests: ${r.passed}/${r.total} passed`);
    console.log(`retrieval eval (BM25 only): hit@1 ${r.hit1}/${r.evals}, hit@5 ${r.hit5}/${r.evals}`);
    for (const f of r.failed) console.error("FAIL " + f);
    failed += r.total - r.passed;
  }
} finally {
  await browser.close();
  server.close();
}

// The deployable bundle must load on its own and serve the non-LLM routes.
try {
  const { default: worker } = await import(pathToFileURL(join(root, "dist/_worker.js")).href);
  const env = { ASSETS: { fetch: async () => new Response("static") } };
  const search = await worker.fetch(new Request("https://hardyalsinghdeora.pages.dev/api/search?q=RAG%20agent&k=3"), env);
  const data = await search.json();
  if (search.status !== 200 || data.hits.length !== 3) throw new Error("/api/search " + search.status);
  const ask = await worker.fetch(new Request("https://hardyalsinghdeora.pages.dev/api/ask", { method: "POST", body: "{}" }), env);
  if (ask.status !== 503) throw new Error("/api/ask without a key should be 503, got " + ask.status);
  console.log("bundle smoke test: passed (" + data.hits.map((h) => h.id).join(", ") + ")");
} catch (e) {
  console.error("FAIL bundle smoke test: " + e.message);
  failed++;
}

process.exit(failed ? 1 : 0);
