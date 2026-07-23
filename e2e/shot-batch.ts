/**
 * Batch screenshots for terrain/foliage QA.
 *   bun run e2e/shot-batch.ts [baseUrl]
 */
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:5200";
const chrome =
  process.env.PW_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const shots: [string, string][] = [
  [`${base}/chunk.html?mode=chunk&x=-3&y=-44&r=11`, "docs/img/shot-chunk-forest.png"],
  [`${base}/chunk.html?mode=gallery`, "docs/img/shot-gallery.png"],
  [`${base}/hero.html`, "docs/img/shot-hero-tile.png"],
  [`${base}/chunk.html?mode=chunk&x=-4.5&y=12&r=8`, "docs/img/shot-chunk-close.png"],
  [`${base}/?x=-4.5&y=12&dist=22&tilt=0.85`, "docs/img/shot-full-civ5.png"],
  // forest-dense framing from full map if present
  [`${base}/chunk.html?mode=chunk&x=10&y=20&r=14`, "docs/img/shot-chunk.png"],
];

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console]", m.text().slice(0, 220));
});

for (const [url, out] of shots) {
  console.log("→", url);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('#app[data-render-state="ready"]', { timeout: 180000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: out });
    console.log("  ok", out);
  } catch (e) {
    console.log("  FAIL", (e as Error).message.slice(0, 400));
  }
}
await browser.close();
