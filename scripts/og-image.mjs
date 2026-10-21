// Renders the link-preview card (public/og-image.png, 1200x630) and the home-screen icon
// (public/apple-touch-icon.png, 180x180) in headless Chromium. Run after changing the headline:
//   node scripts/og-image.mjs
// The PNGs are committed, so the build and the deploy never need a browser.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = JSON.parse(readFileSync(join(root, "knowledge/profile.json"), "utf8")).identity;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const FONT = `Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const GLYPH = `background:linear-gradient(140deg,#4B47A8,#2A639B);color:#fff;display:grid;place-items:center;font-weight:800`;

const card = `<!doctype html><html><body style="margin:0">
<div style="width:1200px;height:630px;box-sizing:border-box;padding:72px 80px;background:#0D0F11;color:#F1F3F4;
  font-family:${FONT};display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden">
  <div style="position:absolute;left:64px;bottom:-70px;font-size:250px;font-weight:800;letter-spacing:-.045em;color:#181C1F">HARDYAL</div>
  <div style="display:flex;align-items:center;gap:22px;position:relative">
    <div style="width:84px;height:84px;border-radius:24px;font-size:32px;${GLYPH}">HS</div>
    <div style="font-size:34px;font-weight:700">${esc(id.display_name)}</div>
  </div>
  <div style="position:relative">
    <div style="font-size:60px;font-weight:800;line-height:1.08;letter-spacing:-.02em;max-width:980px">${esc(id.headline_short)}</div>
    <div style="font-size:28px;line-height:1.4;color:#A8B0B6;margin-top:24px;max-width:960px">
      LLM agents that are grounded, bounded, least-privilege and auditable. ${esc(id.total_experience_years)} years of production backend underneath.</div>
  </div>
  <div style="display:flex;align-items:center;gap:14px;font-size:26px;color:#8189F5;position:relative">
    <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#54C6B4"></span>
    Ask my portfolio agent anything &#183; hardyalsinghdeora.pages.dev
  </div>
</div></body></html>`;

const icon = `<!doctype html><html><body style="margin:0">
<div style="width:180px;height:180px;font-family:${FONT};font-size:72px;${GLYPH}">HS</div></body></html>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(card);
  await page.screenshot({ path: join(root, "public/og-image.png") });
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(icon);
  await page.screenshot({ path: join(root, "public/apple-touch-icon.png") });
  console.log("wrote public/og-image.png and public/apple-touch-icon.png");
} finally {
  await browser.close();
}
