/**
 * RECON del Buzón Tributario: se loguea con e.firma (mismo flujo probado del CE)
 * y ENUMERA todos los servicios disponibles (operacion/00834) + marca los de
 * Declaraciones. No descarga nada: sólo mapea qué se puede sacar con la MISMA
 * sesión. Vuelca la lista + el HTML para inspección.
 *
 * Uso: DATABASE_URL=… CREDENTIALS_ENCRYPTION_KEY=… [RFC=CBA170606FQ8] \
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-recon-buzon.ts
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import { chromium } from "playwright";
import { decryptSecret } from "../src/lib/crypto";

const RFC = process.env.RFC ?? "CBA170606FQ8"; // bartiz
const OUT = `${process.env.CLAUDE_JOB_DIR ?? "/tmp"}/tmp`;
const ENTRADA = "https://wwwmat.sat.gob.mx/app/seg/cont/accesoC?url=/buzon&idSessionBit=0";
const SERVICIOS = "https://wwwmat.sat.gob.mx/operacion/00834/servicios-disponibles-del-buzon-tributario";

async function main() {
  const prisma = new PrismaClient();
  const c = await prisma.company.findFirst({
    where: { rfc: RFC },
    select: { rfc: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  await prisma.$disconnect();
  if (!c?.fielCer || !c?.fielKey || !c?.fielPassword) throw new Error(`${RFC} sin FIEL.`);
  const cerDer = Buffer.from(decryptSecret(c.fielCer), "base64");
  const keyDer = Buffer.from(decryptSecret(c.fielKey), "base64");
  const pass = decryptSecret(c.fielPassword);
  console.log(`FIEL ${RFC} cargada — recon del buzón`);

  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  try {
    // ── Login e.firma (idéntico al flujo probado de CE) ──
    await page.goto(ENTRADA, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.locator("#buttonFiel").click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1600);
    if ((await page.locator("#fileCertificate").count()) > 0) {
      const cer = `${OUT}/rec-fiel.cer`, key = `${OUT}/rec-fiel.key`;
      fs.writeFileSync(cer, cerDer);
      fs.writeFileSync(key, keyDer);
      await page.locator("#fileCertificate").setInputFiles(cer).catch(() => {});
      await page.locator("#filePrivateKey").setInputFiles(key).catch(() => {});
      await page.locator("#privateKeyPassword").fill(pass).catch(() => {});
      await page.locator("#submit").click({ timeout: 8000 }).catch(() => {});
      await page.waitForURL((u) => /wwwmat\.sat\.gob\.mx\/(buzon|operacion)/.test(String(u)), { timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    }
    const okLogin = /wwwmat\.sat\.gob\.mx\/(buzon|operacion)/.test(page.url());
    console.log(`login: ${okLogin ? "✅" : "❌"} ${page.url().slice(0, 72)}`);
    if (!okLogin) { console.log("no autenticó; aborto recon."); return; }

    // ── Servicios disponibles del buzón ──
    await page.goto(SERVICIOS, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    fs.writeFileSync(`${OUT}/recon-servicios.html`, await page.content().catch(() => ""));
    console.log(`servicios: ${page.url().slice(0, 80)}`);

    // Enumerar links de servicio en TODOS los frames.
    const todos: { id: string; txt: string; href: string }[] = [];
    for (const fr of page.frames()) {
      const links = await fr
        .evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .map((a) => ({ href: (a as HTMLAnchorElement).href, txt: ((a as HTMLElement).textContent || (a as HTMLElement).title || "").replace(/\s+/g, " ").trim().slice(0, 64) }))
            .filter((x) => /\/(operacion|consultas|aplicacion)\/\d+\//.test(x.href)),
        )
        .catch(() => [] as { href: string; txt: string }[]);
      for (const l of links) todos.push({ id: /\/(\d+)\//.exec(l.href)?.[1] ?? "?", txt: l.txt, href: l.href.replace("https://wwwmat.sat.gob.mx", "") });
    }
    const seen = new Set<string>();
    const uniq = todos.filter((s) => (seen.has(s.href) ? false : (seen.add(s.href), true)));
    uniq.sort((a, b) => a.id.localeCompare(b.id));

    console.log(`\n=== ${uniq.length} SERVICIOS ENUMERADOS ===`);
    for (const s of uniq) console.log(`  [${s.id}] ${s.txt || "(sin texto)"}  ${s.href}`);

    const grupos: Record<string, RegExp> = {
      "DECLARACIONES": /declaraci/i,
      "CONTABILIDAD ELECTRÓNICA": /contabilidad/i,
      "CONSTANCIA / SITUACIÓN FISCAL": /constancia|situaci[oó]n fiscal|c[eé]dula/i,
      "OPINIÓN DE CUMPLIMIENTO (32-D)": /cumplimiento|32.?d|opini[oó]n/i,
      "FACTURAS / CFDI": /factura|cfdi/i,
      "NOTIFICACIONES / BUZÓN": /notificaci|buz[oó]n/i,
      "DEVOLUCIONES / COMPENSACIONES": /devoluci|compensaci/i,
    };
    for (const [nombre, re] of Object.entries(grupos)) {
      const hits = uniq.filter((s) => re.test(`${s.txt} ${s.href}`));
      if (hits.length) console.log(`\n— ${nombre} (${hits.length}) —`), hits.forEach((h) => console.log(`   [${h.id}] ${h.txt} ${h.href}`));
    }
    fs.writeFileSync(`${OUT}/recon-servicios.json`, JSON.stringify(uniq, null, 2));
    console.log(`\nlista → recon-servicios.json · html → recon-servicios.html`);

    // ── Probar servicios de ALTO VALOR con la MISMA sesión (¿cargan? ¿qué form?) ──
    const targets: [string, string][] = [
      ["decl-acuses", "https://wwwmat.sat.gob.mx/aplicacion/login/77792/reimprime-tus-acuses-de-declaraciones-presentadas"],
      ["decl-transacciones", "https://wwwmat.sat.gob.mx/aplicacion/login/22513/transacciones-de-declaraciones-y-pagos-que-haz-realizado-para-cubrir-tus-obligaciones-fiscales"],
      ["csf-rfc", "https://wwwmat.sat.gob.mx/aplicacion/login/43824/reimprime-tus-acuses-del-rfc"],
    ];
    for (const [nombre, url] of targets) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(2600);
        fs.writeFileSync(`${OUT}/recon-${nombre}.html`, await page.content().catch(() => ""));
        const appFrames = page.frames().map((f) => f.url()).filter((u) => /clouda|aplicacionesc|declara|portal/i.test(u) && !/wwwmat\.sat\.gob\.mx\/(operacion|aplicacion|consultas)\//.test(u));
        let campos: unknown[] = [];
        for (const fr of page.frames()) {
          const cs = await fr
            .evaluate(() =>
              Array.from(document.querySelectorAll("input,select,button"))
                .map((e: unknown) => { const x = e as HTMLInputElement & HTMLSelectElement; return { t: x.tagName, ty: (x as HTMLInputElement).type, name: x.name, id: x.id, txt: ((x as HTMLElement).textContent || (x as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 20), opts: x.tagName === "SELECT" ? Array.from((x as HTMLSelectElement).options).map((o) => `${o.value}=${o.text}`).slice(0, 12) : undefined }; })
                .filter((v) => v.name || v.id),
            )
            .catch(() => [] as unknown[]);
          if ((cs as unknown[]).length > campos.length) campos = cs as unknown[];
        }
        const err403 = /403|forbidden|no autoriz|servicio no disponible/i.test(await page.content().catch(() => ""));
        console.log(`\n[${nombre}] → ${page.url().slice(0, 72)} ${err403 ? "⚠(403/err)" : ""}`);
        console.log(`   app iframe: ${JSON.stringify(appFrames)}`);
        console.log(`   campos(${(campos as unknown[]).length}): ${JSON.stringify(campos).slice(0, 1000)}`);
      } catch (e) {
        console.log(`[${nombre}] error: ${String(e).slice(0, 70)}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
