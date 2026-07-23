/**
 * Headless screenshot of the running dev/preview server.
 * Waits on the data-render-state readiness contract, not timers.
 *
 *   bun run e2e/screenshot.ts [url] [outPath]
 */

import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const out = process.argv[3] ?? "/tmp/civ5look.png";

const chromeCandidates = [
  process.env.PW_CHROME,
  "/opt/pw-browsers/chromium",
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
].filter(Boolean) as string[];

const browser = await chromium.launch({
  executablePath: chromeCandidates[0],
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await (
  await browser.newContext({ viewport: { width: 1920, height: 1080 } })
).newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("[page]", m.type(), m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('#app[data-render-state="ready"]', { timeout: 120000 });
// two extra frames so textures decoded after state flip are drawn
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log("screenshot:", out);
await browser.close();
