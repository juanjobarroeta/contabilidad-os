const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const HTML = path.join(__dirname, "html"), PNG = path.join(__dirname, "png");
// CHROMIUM_PATH apunta a un Chromium ya instalado; sin ella, Playwright usa el suyo
// (npx playwright install chromium).
const exe = process.env.CHROMIUM_PATH;
(async () => {
  fs.mkdirSync(PNG, { recursive: true });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 920 }, deviceScaleFactor: 2 });
  for (const f of fs.readdirSync(HTML).filter(f => f.endsWith(".html"))) {
    const name = f.replace(/\.html$/, "");
    await page.goto("file://" + path.join(HTML, f));
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(PNG, name + ".png") });
    console.log("  " + name + ".png");
  }
  await browser.close();
})();
