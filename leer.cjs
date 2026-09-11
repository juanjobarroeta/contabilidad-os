const fs = require("fs");
(async () => {
  const { PDFParse } = require("pdf-parse");
  for (const f of process.argv.slice(2)) {
    const buf = fs.readFileSync(f);
    const parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    console.log("=================== " + f.split("/").pop());
    console.log(r.text.slice(0, 4000));
    await parser.destroy();
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
