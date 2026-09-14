/**
 * Sonda IDSE / SIPARE con e.firma — paso 10 del diseño de nómina
 * (docs/nomina/DISENO-nomina-hub.md §8.3). Responde UNA pregunta antes de
 * construir el `imss-worker`: ¿la e.firma que ya guardamos entra al IDSE sin
 * captcha, y desde ahí se ve la emisión (EMA/EBA)? Y de paso: ¿el SIPARE
 * ofrece entrada con e.firma o sólo usuario+contraseña+captcha?
 *
 * SÓLO LEE. No da de alta ni de baja a nadie, no genera línea de captura, no
 * descarga nada que no sea una captura de pantalla. Misma receta que la CE del
 * SAT (abrirBuzonSat): Chromium real, la e.firma se sube al formulario y el JS
 * del portal firma. Si el login pide captcha, se para ahí y lo documenta.
 *
 * Env: DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY (+ Chromium). Una empresa:
 * RFC=… o COMPANY_ID=…. Opcionales: PROBE_DIR (capturas; /tmp/probe-idse),
 * HEADLESS=0 para verlo en la Mac. Persiste el resultado en AuditLog
 * (accion imss.probe-idse) para leerlo desde la base cuando corre en Railway.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Page } from "playwright";
import { getFielBytes } from "../src/lib/sat-portal/buzon-playwright";

const prisma = new PrismaClient();
const IDSE = "https://idse.imss.gob.mx/imss/";
const SIPARE = "https://sipare.imss.gob.mx/";
const DIR = process.env.PROBE_DIR ?? path.join(os.tmpdir(), "probe-idse");

interface Inventario {
  url: string;
  titulo: string;
  captcha: string[];
  inputs: { tipo: string; id: string; name: string; accept: string }[];
  botonesEfirma: string[];
  textos: string[];
}

/** Qué hay en la página: captcha, inputs, botones que hablen de e.firma. */
async function inventariar(page: Page, textosClave: RegExp): Promise<Inventario> {
  const captcha = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img[src*='aptcha' i], iframe[src*='recaptcha' i], .g-recaptcha, [id*='captcha' i], [class*='captcha' i], .h-captcha"))
      .map((el) => `${el.tagName.toLowerCase()}#${(el as HTMLElement).id || "-"}.${(el as HTMLElement).className || "-"}`)
      .slice(0, 6),
  );
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map((i) => ({ tipo: i.type, id: i.id, name: i.name, accept: i.accept })).filter((i) => i.tipo !== "hidden").slice(0, 25),
  );
  const botonesEfirma = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button], label, li, span"))
      .map((el) => ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 80 && /e\.?\s?firma|fiel|certificado|\.cer|\.key|\.pfx|npie/i.test(t))
      .slice(0, 12),
  );
  const cuerpo = await page.evaluate(() => document.body?.innerText ?? "");
  const textos = cuerpo.split(/\n+/).map((l) => l.trim()).filter((l) => l && textosClave.test(l)).slice(0, 15);
  return { url: page.url(), titulo: await page.title(), captcha, inputs, botonesEfirma, textos };
}

async function captura(page: Page, nombre: string): Promise<string> {
  const f = path.join(DIR, `${nombre}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return f;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const soloRfc = process.env.RFC;
  const soloId = process.env.COMPANY_ID;
  if (!soloRfc && !soloId) throw new Error("Indica RFC=… o COMPANY_ID=…");
  const company = await prisma.company.findFirst({
    where: soloId ? { id: soloId } : { rfc: soloRfc },
    select: { id: true, rfc: true, razonSocial: true, registroPatronal: true },
  });
  if (!company) throw new Error(`Empresa no encontrada (${soloRfc ?? soloId})`);
  console.log(`── Sonda IDSE/SIPARE · ${company.rfc} ${company.razonSocial} · RP ${company.registroPatronal ?? "—"}`);
  const fiel = await getFielBytes(company.id);

  const resultado: Record<string, unknown> = { rfc: company.rfc, inicio: new Date().toISOString(), capturas: [] as string[] };
  const capturas = resultado.capturas as string[];
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "0",
    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fiel-${company.rfc}-`));
  const cerPath = path.join(tmp, "e.cer");
  const keyPath = path.join(tmp, "e.key");
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "es-MX" });
    const page = await ctx.newPage();

    // ── 1. IDSE: portada del login ─────────────────────────────────────────
    console.log("\n1. IDSE — portada");
    await page.goto(IDSE, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("   goto:", e.message));
    let inv = await inventariar(page, /e\.?firma|fiel|certificado|contraseña|usuario|captcha|registro patronal/i);
    capturas.push(await captura(page, "1-idse-portada"));
    resultado.idsePortada = inv;
    console.log(`   ${inv.titulo} · ${inv.url}`);
    console.log(`   captcha: ${inv.captcha.length ? inv.captcha.join(", ") : "no se ve"}`);
    console.log(`   inputs: ${inv.inputs.map((i) => `${i.tipo}#${i.id || i.name || "-"}`).join(", ") || "ninguno"}`);
    console.log(`   e.firma: ${inv.botonesEfirma.join(" | ") || "no hay botón/texto de e.firma"}`);

    // ── 2. IDSE: ruta e.firma ──────────────────────────────────────────────
    console.log("\n2. IDSE — ruta e.firma");
    const efirma = page.locator("a, button, label, li, span, input[type=button], input[type=submit]").filter({ hasText: /e\.?\s?firma|fiel/i }).first();
    if (await efirma.count()) {
      await efirma.click({ timeout: 8000 }).catch((e) => console.log("   clic e.firma:", e.message));
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    }
    inv = await inventariar(page, /e\.?firma|fiel|certificado|contraseña|llave|captcha/i);
    capturas.push(await captura(page, "2-idse-efirma"));
    resultado.idseEfirma = inv;
    const files = inv.inputs.filter((i) => i.tipo === "file");
    const pass = inv.inputs.find((i) => i.tipo === "password");
    console.log(`   file inputs: ${files.map((f) => `#${f.id || f.name} (${f.accept || "*"})`).join(", ") || "ninguno"} · password: ${pass ? `#${pass.id || pass.name}` : "ninguno"} · captcha: ${inv.captcha.length ? "SÍ" : "no"}`);

    // ── 3. IDSE: intento de login con e.firma (si hay dónde) ──────────────
    if (files.length >= 2 && pass && inv.captcha.length === 0) {
      console.log("\n3. IDSE — login con e.firma");
      fs.writeFileSync(cerPath, fiel.cerDer);
      fs.writeFileSync(keyPath, fiel.keyDer);
      const sel = (i: { id: string; name: string }) => (i.id ? `#${CSS.escape(i.id)}` : `input[name="${i.name}"]`);
      // El .cer suele ir primero; si el accept lo dice, se respeta.
      const cerInput = files.find((f) => /cer/i.test(f.accept + f.id + f.name)) ?? files[0];
      const keyInput = files.find((f) => f !== cerInput && /key/i.test(f.accept + f.id + f.name)) ?? files.find((f) => f !== cerInput)!;
      await page.locator(sel(cerInput)).setInputFiles(cerPath);
      await page.locator(sel(keyInput)).setInputFiles(keyPath);
      await page.locator(sel(pass)).fill(fiel.pass);
      const rfcInput = inv.inputs.find((i) => /rfc/i.test(i.id + i.name));
      if (rfcInput) await page.locator(sel(rfcInput)).fill(company.rfc).catch(() => {});
      const antes = page.url();
      await page.locator("button[type=submit], input[type=submit], button:has-text('Ingresar'), a:has-text('Ingresar'), button:has-text('Entrar')").first().click({ timeout: 8000 }).catch((e) => console.log("   submit:", e.message));
      await page.waitForURL((u) => String(u) !== antes, { timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      const dentro = await inventariar(page, /emisi[oó]n|ema|eba|confronta|movimientos afiliatorios|afiliaci[oó]n|bienvenid|error|inv[aá]lid|incorrect|no autorizado|captcha/i);
      capturas.push(await captura(page, "3-idse-tras-login"));
      resultado.idseTrasLogin = dentro;
      const entro = dentro.url !== antes && !/error|inv[aá]lid|incorrect|no autorizado/i.test(dentro.textos.join(" "));
      resultado.idseEntro = entro;
      console.log(`   ${entro ? "✓ ENTRÓ" : "✗ no entró"} · ${dentro.titulo} · ${dentro.url}`);
      console.log(`   textos: ${dentro.textos.slice(0, 8).join(" | ")}`);
    } else {
      resultado.idseEntro = null;
      console.log(`\n3. IDSE — login omitido: ${inv.captcha.length ? "hay captcha" : "no hay formulario de e.firma reconocible"} (ver capturas)`);
    }

    // ── 4. SIPARE: sólo mirar la portada ───────────────────────────────────
    console.log("\n4. SIPARE — portada (sin login)");
    const p2 = await ctx.newPage();
    await p2.goto(SIPARE, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("   goto:", e.message));
    const invS = await inventariar(p2, /e\.?firma|fiel|certificado|contraseña|usuario|captcha|registr/i);
    capturas.push(await captura(p2, "4-sipare-portada"));
    resultado.siparePortada = invS;
    console.log(`   ${invS.titulo} · ${invS.url}`);
    console.log(`   captcha: ${invS.captcha.length ? "SÍ" : "no se ve"} · inputs: ${invS.inputs.map((i) => `${i.tipo}#${i.id || i.name || "-"}`).join(", ") || "ninguno"}`);
    console.log(`   e.firma: ${invS.botonesEfirma.join(" | ") || "no hay botón/texto de e.firma"}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await browser.close().catch(() => {});
  }
  resultado.fin = new Date().toISOString();
  console.log(`\nCapturas en ${DIR}`);
  try {
    await prisma.auditLog.create({
      data: { companyId: company.id, accion: "imss.probe-idse", entidad: "Company", entidadId: company.id, detalle: JSON.parse(JSON.stringify(resultado)) },
    });
    console.log("Resultado guardado en AuditLog (imss.probe-idse).");
  } catch (e) {
    console.error("⚠ no se pudo persistir:", e instanceof Error ? e.message : e);
  }
}

main()
  .catch((e) => { console.error("✗", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
