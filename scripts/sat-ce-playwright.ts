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
import * as fs from "node:fs";
import { chromium } from "playwright";
import { decryptSecret } from "../src/lib/crypto";

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
  console.log(`FIEL ${RFC} cargada (cer ${cerDer.length}b · key ${keyDer.length}b) — firma el JS del SAT`);

  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    args: ["--ignore-certificate-errors", "--ssl-version-min=tls1"],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();

  // Cualquier descarga que dispare la página se guarda en OUT.
  const descargados: string[] = [];
  page.on("download", async (d) => {
    const fn = d.suggestedFilename() || `descarga-${descargados.length}.bin`;
    try { await d.saveAs(`${OUT}/${fn}`); descargados.push(fn); console.log(`   ⬇ ${fn}`); }
    catch (e) { console.log("   ⬇ falló:", String(e).slice(0, 50)); }
  });

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

    // Flujo REAL del navegador (como la persona): subir .cer/.key + contraseña y
    // pulsar "Enviar" (#submit → firmar(event), que firma con sjcl+jsrsasign y
    // envía el certform). Es más robusto que inyectar el token a mano.
    const esCertform = /name=["']guid["']/i.test(st.cuerpo) && (await page.locator("#fileCertificate").count()) > 0;
    console.log(`3) certform e.firma con file inputs = ${esCertform}`);
    if (esCertform) {
      const cer = `${OUT}/pw-fiel.cer`, key = `${OUT}/pw-fiel.key`;
      fs.writeFileSync(cer, cerDer);
      fs.writeFileSync(key, keyDer);
      console.log("   subo .cer/.key + contraseña y pulso Enviar (firma el JS del SAT)…");
      await page.locator("#fileCertificate").setInputFiles(cer).catch((e) => console.log("   cer:", String(e).slice(0, 50)));
      await page.locator("#filePrivateKey").setInputFiles(key).catch((e) => console.log("   key:", String(e).slice(0, 50)));
      await page.locator("#privateKeyPassword").fill(pass).catch(() => {});
      await page.locator("#submit").click({ timeout: 8000 }).catch(() =>
        page.evaluate(() => (document.getElementById("submit") as HTMLElement | null)?.click()),
      );
      await page.waitForURL((u) => /wwwmat\.sat\.gob\.mx\/(buzon|operacion)/.test(String(u)), { timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      st = await marca("tras enviar e.firma");
    } else {
      console.log("   ⚠ no apareció el certform con file inputs; ver pw-efirma.html.");
    }

    // Dar tiempo a la cadena SAML/AG y ver dónde quedamos.
    await page.waitForTimeout(2500);
    const fin = await marca("ATERRIZAJE (buzón)");
    fs.writeFileSync(`${OUT}/pw-final.html`, fin.cuerpo);
    await page.screenshot({ path: `${OUT}/pw-final.png`, fullPage: true }).catch(() => {});

    // 4) CONSULTA DE ACUSES CE (operacion/16203) DENTRO de la sesión: capturar el
    //    formulario de búsqueda (campos, selects con opciones, botón Buscar) y
    //    detectar si la app va en un iframe / en aplicacionesc.
    if (fin.esCE) {
      console.log("4) navego a la consulta de acuses (16203)…");
      await page
        .goto("https://wwwmat.sat.gob.mx/consultas/login/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica", { waitUntil: "networkidle", timeout: 60000 })
        .catch(() => {});
      await page.waitForTimeout(2500);
      const cst = await marca("consulta 16203");
      fs.writeFileSync(`${OUT}/pw-consulta.html`, cst.cuerpo);
      const frames = page.frames().map((f) => f.url()).filter((u) => /sat\.gob/.test(u) && u !== page.url());
      console.log("   FRAMES:", JSON.stringify(frames));
      // Capturar el form en el frame que lo tenga (main o iframe).
      for (const fr of page.frames()) {
        const campos = await fr
          .evaluate(() =>
            Array.from(document.querySelectorAll("input,select,button,a[onclick]"))
              .map((e: any) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id, txt: (e.textContent || e.value || "").replace(/\s+/g, " ").trim().slice(0, 22), opts: e.tagName === "SELECT" ? Array.from(e.options).map((o: any) => `${o.value}=${o.text}`).slice(0, 16) : undefined }))
              .filter((x: any) => x.name || (x.id && /buscar|anio|año|mes|tipo|estado|periodo|criterio|folio|ejercicio/i.test(`${x.id}${x.txt}`)) || /buscar|descargar/i.test(x.txt)),
          )
          .catch(() => []);
        if (campos.length) {
          console.log(`   [frame ${fr.url().slice(0, 50)}] CAMPOS:`, JSON.stringify(campos).slice(0, 1200));
          fs.writeFileSync(`${OUT}/pw-consulta-frame.html`, await fr.content().catch(() => ""));
        }
      }

      // 5) Llenar el form en el IFRAME de la app (ceportalconsulta…) y BUSCAR;
      //    descargar los XML de la lista (el handler global guarda cada archivo).
      const appFrame = page.frames().find((f) => /ceportalconsulta/.test(f.url()));
      if (appFrame) {
        const anio = process.env.ANIO ?? "2026";
        const tipo = process.env.TIPOARCH ?? "0"; // 0=Todos, 1=CT, 2=B(alanza)
        console.log(`5) lleno el form (año ${anio}, meses 1–13, tipo ${tipo}, todos estatus/envío) y Busco…`);
        await appFrame.check("#rdoCriterios").catch(() => {});
        await appFrame.selectOption("#ddlAnio", anio).catch((e) => console.log("   anio:", String(e).slice(0, 40)));
        await appFrame.selectOption("#ddlMesInicio", "1").catch(() => {});
        await appFrame.selectOption("#ddlMesFin", "13").catch(() => {});
        await appFrame.selectOption("#ddlMotivo", process.env.MOTIVO ?? "0").catch(() => {}); // Motivo (REQUERIDO): 0=Todos, 7=Envío Mensual
        await appFrame.selectOption("#ddlTipoArchivo", tipo).catch(() => {});
        await appFrame.selectOption("#ddlEstatus", "0").catch(() => {});
        await appFrame.selectOption("#ddlTipoEnvio", "0").catch(() => {});
        await appFrame.click("#btnBuscar").catch((e) => console.log("   buscar:", String(e).slice(0, 40)));
        await page.waitForTimeout(5000);
        fs.writeFileSync(`${OUT}/pw-resultados.html`, await appFrame.content().catch(() => ""));
        const info = await appFrame.evaluate(() => {
          const rows = document.querySelectorAll("table tr, tbody tr").length;
          const dl = Array.from(document.querySelectorAll("a[href],button,[onclick],img[onclick],span[onclick],i[onclick]"))
            .map((e: any) => ({ t: (e.textContent || e.title || e.alt || "").replace(/\s+/g, " ").trim().slice(0, 24), href: e.href || "", oc: ((e.getAttribute && e.getAttribute("onclick")) || "").slice(0, 70), id: e.id }))
            .filter((x: any) => /descarg|xml|acuse|\.zip|download|\.xls/i.test(`${x.t} ${x.href} ${x.oc} ${x.id}`))
            .slice(0, 25);
          return { rows, dl, texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260) };
        });
        console.log(`   filas tabla: ${info.rows} · descargables: ${info.dl.length}`);
        console.log("   texto:", JSON.stringify(info.texto));
        if (info.dl.length) console.log("   dl:", JSON.stringify(info.dl).slice(0, 1500));
        // El XML de cada acuse se baja con VerXML('<folio>') del onclick. Extraer
        // los folios y llamar la función; el XML llega por download o por pestaña.
        const folios: string[] = await appFrame.evaluate(() => {
          const s = new Set<string>();
          document.querySelectorAll("[onclick]").forEach((e) => {
            const m = /VerXML\('([^']+)'\)/.exec(e.getAttribute("onclick") || "");
            if (m) s.add(m[1]);
          });
          return Array.from(s);
        });
        console.log(`   folios con XML: ${folios.length} → ${folios.join(",").slice(0, 120)}`);
        // VerXML dispara una descarga (ZIP con el XML). El handler global la guarda;
        // sólo hay que llamar la función y dar un respiro entre folios.
        for (const folio of folios.slice(0, 30)) {
          await appFrame.evaluate((f) => (window as unknown as { VerXML: (x: string) => void }).VerXML(f), folio).catch(() => {});
          await page.waitForTimeout(1200);
        }
        await page.waitForTimeout(2500); // esperar las últimas descargas
        console.log(`   ARCHIVOS DESCARGADOS: ${descargados.length} → ${descargados.join(", ") || "(ninguno)"}`);
      } else {
        console.log("5) no encontré el iframe de la app de consulta (ceportalconsulta).");
      }
    } else {
      console.log("4) (no aterrizó en buzón; me salto la consulta)");
    }

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
