/**
 * CE por NAVEGADOR REAL (Playwright/Chromium) — resuelve el nudo del Access
 * Gateway que el cliente HTTP a mano no pasa (la sesión no se pega, bucle a
 * plogin). Un navegador de verdad maneja cookies/F5/redirects como el de la
 * persona. Reusa NUESTRA firma e.firma (auth.ts) pero la ENVÍA dentro del
 * navegador; luego deja que el browser siga la aserción y la sesión del AG.
 *
 * Documenta TODO: traza de red (url, método, Cookie), cookies finales, dónde
 * aterriza. Con eso o (a) arreglamos el camino HTTP barato, o (b) esto MISMO es
 * la automatización (determinista, ~$0/corrida, corre headless en el server).
 *
 * Uso: DATABASE_URL=… CREDENTIALS_ENCRYPTION_KEY=… [RFC=AMA170817NK1] [HEADED=1] \
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-ce-playwright.ts
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { chromium } from "playwright";
import { decryptSecret } from "../src/lib/crypto";
import { extraerReto, firmarReto, cuerpoDeLogin, type FirmanteFiel } from "../src/lib/sat-portal/auth";

const RFC = process.env.RFC ?? "AMA170817NK1";
const OUT = `${process.env.CLAUDE_JOB_DIR ?? "/tmp"}/tmp`;
const ENTRADA = "https://wwwmat.sat.gob.mx/app/seg/cont/accesoC?url=/buzon&idSessionBit=0";
const FIEL_CONTRATO = "https://login.siat.sat.gob.mx/nidp/idff/sso?id=fiel_Aviso&sid=0&option=credential";

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
  const x509 = new crypto.X509Certificate(cerDer);
  const priv = crypto.createPrivateKey({ key: keyDer, format: "der", type: "pkcs8", passphrase: pass });
  const serial = Buffer.from(x509.serialNumber, "hex").toString("ascii");
  const p2 = (n: number) => String(n).padStart(2, "0");
  const d = new Date(x509.validTo);
  const fert =
    p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + "Z";
  const firmante: FirmanteFiel = {
    sign: (data, algo = "sha1") =>
      crypto.sign(algo === "sha256" ? "sha256" : "sha1", Buffer.from(data, "utf8"), priv).toString("binary"),
    rfc: () => c.rfc!,
    certificate: () => ({ pemAsOneLine: () => "", serialNumber: () => ({ decimal: () => serial }), validTo: () => fert }),
  };
  console.log(`FIEL ${RFC} · serie ${serial} · vence ${fert}`);

  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    args: ["--ignore-certificate-errors", "--ssl-version-min=tls1"],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // Traza de red: cada request con su Cookie, cada response con status/redirect.
  const traza: string[] = [];
  page.on("response", (res) => {
    const req = res.request();
    const u = new URL(res.url());
    if (/sat\.gob\.mx/.test(u.host)) {
      const ck = (req.headers()["cookie"] ?? "").split(";").map((s) => s.split("=")[0].trim()).filter(Boolean).join(",");
      traza.push(`${res.status()} ${req.method()} ${u.host}${u.pathname.slice(0, 46)}  cookie{${ck || "-"}}`);
    }
  });

  const marca = async (etiqueta: string) => {
    // Esperar a que la navegación asiente antes de leer (evita el error de
    // "page is navigating"); reintentar la lectura del contenido.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    let cuerpo = "";
    for (let i = 0; i < 4; i++) {
      try { cuerpo = await page.content(); break; } catch { await page.waitForTimeout(1200); }
    }
    const url = page.url();
    const esCE = /consulta.*acuse|acuses?\s+generad|balanza|cat[aá]logo de cuentas|buz[oó]n tributario|servicios? disponibles?/i.test(cuerpo);
    const esLogin = /credentialsRequired|iniciar sesi|contrase|e\.firma/i.test(cuerpo) && /login\.siat|nidp/.test(url);
    console.log(`  · ${etiqueta}: ${url.slice(0, 78)}  ${esCE ? "★CE" : ""}${esLogin ? "‹login›" : ""}  (${cuerpo.length}b)`);
    return { url, cuerpo, esCE, esLogin };
  };

  try {
    console.log("1) voy a la entrada del buzón (navegador real sigue todo)…");
    await page.goto(ENTRADA, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await marca("tras entrada");

    // En la TARJETA de login, PULSAR "e.firma" (como la persona) — un GET directo
    // a fiel_Aviso devuelve vacío; el tab hace el cambio de contrato con estado.
    let st = await marca("tras entrada");
    fs.writeFileSync(`${OUT}/pw-login.html`, st.cuerpo);
    console.log("2) pulso #buttonFiel (el tab e.firma navega a fiel_Aviso)…");
    await page.locator("#buttonFiel").click({ timeout: 8000 }).catch((e) => console.log("   click falló:", String(e).slice(0, 60)));
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1800);
    st = await marca("tras #buttonFiel");
    fs.writeFileSync(`${OUT}/pw-efirma.html`, st.cuerpo);
    if (st.cuerpo.length < 900) console.log("   página e.firma (cruda):", JSON.stringify(st.cuerpo.slice(0, 900)));

    // Probe: ¿el certform aparece vía request-context (con las cookies del browser)?
    // Así llegó nuestro flujo HTTP al certform; si aquí también, firmamos y POSTeamos.
    const probe = await ctx.request
      .get("https://login.siat.sat.gob.mx/nidp/idff/sso?id=fiel_Aviso&sid=0&option=credential", { headers: { Accept: "text/html" } })
      .catch(() => null);
    if (probe) {
      const pb = await probe.text();
      console.log(`   probe fiel_Aviso(request-ctx): ${probe.status()} · ${pb.length}b · guid=${/name=["']guid["']/i.test(pb)}`);
      fs.writeFileSync(`${OUT}/pw-fiel-probe.html`, pb);
      if (/name=["']guid["']/i.test(pb) && !/name=["']guid["']/i.test(st.cuerpo)) {
        // El certform vino por request-context: firmar y POSTear ahí (cookies del browser),
        // luego navegar al buzón para que el navegador sostenga la sesión del AG.
        const reto = extraerReto(pb, "https://login.siat.sat.gob.mx/nidp/idff/sso?id=fiel_Aviso&sid=0&option=credential");
        const sobre = firmarReto(reto, firmante);
        console.log(`   firmo (guid ${reto.guid.slice(0, 10)}…) y POST vía request-context…`);
        await ctx.request.post(reto.actionUrl, {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
          data: cuerpoDeLogin(reto, sobre),
        }).catch((e) => console.log("   POST falló:", String(e).slice(0, 60)));
        await page.goto("https://wwwmat.sat.gob.mx/buzon", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        st = await marca("tras federar+ir a /buzon");
      }
    }

    // ¿Qué es el form de e.firma? certform (inyectamos token) o subida de .cer/.key.
    const esCertform = /name=["']guid["']/i.test(st.cuerpo);
    const nFiles = await page.locator('input[type="file"]').count();
    console.log(`3) form e.firma → certform=${esCertform} · inputs file=${nFiles}`);
    if (esCertform) {
      const reto = extraerReto(st.cuerpo, page.url());
      const sobre = firmarReto(reto, firmante);
      const campos = Object.fromEntries(new URLSearchParams(cuerpoDeLogin(reto, sobre)));
      console.log(`   firmo (guid ${reto.guid.slice(0, 10)}…) y envío el certform…`);
      await page.evaluate((vals) => {
        const forms = Array.from(document.forms);
        const f = (document.forms as any)["certform"] || forms.find((x) => x.querySelector('[name="guid"]')) || forms[0];
        if (!f) return;
        for (const [k, v] of Object.entries(vals)) {
          let el = f.elements.namedItem(k) as HTMLInputElement | null;
          if (!el) { el = document.createElement("input"); el.type = "hidden"; el.name = k; f.appendChild(el); }
          el.value = String(v);
        }
        (f as HTMLFormElement).submit();
      }, campos);
      await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
      st = await marca("tras enviar certform");
    } else if (nFiles >= 1) {
      // Subida .cer/.key + contraseña (firma del lado del cliente, sin applet).
      const cer = `${OUT}/pw-fiel.cer`, key = `${OUT}/pw-fiel.key`;
      fs.writeFileSync(cer, cerDer); fs.writeFileSync(key, keyDer);
      const files = page.locator('input[type="file"]');
      console.log("   subo .cer/.key y contraseña…");
      // Heurística: 1er file = certificado (.cer), 2º = clave (.key). Password por tipo.
      await files.nth(0).setInputFiles(cer).catch(() => {});
      if (nFiles >= 2) await files.nth(1).setInputFiles(key).catch(() => {});
      await page.locator('input[type="password"]').first().fill(pass).catch(() => {});
      await page.getByRole("button", { name: /enviar|firmar|acceder|continuar|entrar/i }).first().click({ timeout: 8000 }).catch(async () => {
        await page.locator('button[type=submit], input[type=submit]').first().click({ timeout: 8000 }).catch(() => {});
      });
      await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
      st = await marca("tras subir .cer/.key");
    } else {
      console.log("   ⚠ no reconozco el form de e.firma; guardado en pw-efirma.html para revisar.");
    }

    // Dar tiempo a la cadena SAML/AG y ver dónde quedamos.
    await page.waitForTimeout(2500);
    const fin = await marca("ATERRIZAJE");
    fs.writeFileSync(`${OUT}/pw-final.html`, fin.cuerpo);
    await page.screenshot({ path: `${OUT}/pw-final.png`, fullPage: true }).catch(() => {});
    const cookies = await ctx.cookies();
    fs.writeFileSync(`${OUT}/pw-cookies.json`, JSON.stringify(cookies, null, 2));

    console.log(`\n=== TRAZA (${traza.length} requests a sat.gob.mx) ===`);
    console.log(traza.join("\n"));
    console.log(`\n${fin.esCE ? "✅ Aterrizó en algo del buzón/CE" : "❓ No aterrizó en CE"} · html→pw-final.html · png→pw-final.png · cookies→pw-cookies.json`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
