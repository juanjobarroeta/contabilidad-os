/**
 * Recon del portal SAT con la e.firma de ZIONX (empresa propia, autorizada por
 * el dueño). Objetivo ÚNICO: MAPEAR el flujo — grabar el tráfico real de login
 * y de las tres secciones para volverlo fixtures. Estrictamente de LECTURA: no
 * presenta, no envía, no cambia nada en la cuenta del SAT.
 *
 * Qué produce, en ~/.claude/jobs/.../tmp/recon/:
 *   - sat.har         — todas las peticiones/respuestas (el mapa)
 *   - NN-*.png        — captura de cada paso, para revisar qué se vio
 *   - pasos.log       — bitácora de qué hizo y qué encontró
 *
 * La FIEL se descifra a un temporal 0600 y se BORRA al terminar (finally),
 * pase lo que pase. El .key nunca queda en disco más que el tiempo del login.
 *
 * Uso (lo corre el usuario, mirando):
 *   RECON=1 npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/recon-sat-portal.ts
 */
import { PrismaClient } from "@prisma/client";
import { chromium, type Page } from "playwright";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// La empresa cuya FIEL usa el recon. ZIONX sirvió para PROBAR el login (funciona
// en los dos realms), pero no tiene Contabilidad Electrónica — para mapear CE
// hay que usar una que sí la presente, como MARGOM (16,053 renglones CE).
const RFC_OBJETIVO = process.env.RFC || "ZIO190321JI6";
const OUT = path.join(os.homedir(), ".claude/jobs/b2a65a05/tmp/recon");
// El recon 1 reveló el mapa: el portal general (loginc) ofrece cinco métodos
// como menú; el de subir .cer/.key es FormCertiSAT (el CertiSAT clásico).
const URL_LOGIN_FIEL =
  "https://loginc.mat.sat.gob.mx/nidp/jsp/main.jsp?id=FormCertiSAT&sid=0";

// ── Descifrado igual que src/lib/crypto.ts: "enc:v1:iv:tag:ct" en base64 ──
function decryptSecret(stored: string): string {
  if (!stored.startsWith("enc:v1:")) return stored; // legacy en claro
  const keyB64 = fs.readFileSync(path.join(OUT, "..", ".credkey"), "utf8").trim();
  const key = Buffer.from(keyB64, "base64");
  const [, , ivB64, tagB64, ctB64] = stored.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}

const log: string[] = [];
const paso = (m: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  log.push(line);
  console.log(line);
};

async function shot(page: Page, n: number, nombre: string) {
  const base = path.join(OUT, `${String(n).padStart(2, "0")}-${nombre}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  // El DOM renderizado es más fiable que el HAR para ver nombres de campos.
  await page.content().then((h) => fs.writeFileSync(`${base}.html`, h)).catch(() => {});
  // Los nombres de todos los inputs y forms de la página, en la bitácora.
  const campos = await page
    .$$eval("input, select, form, button[type=submit]", (els) =>
      els.map((el) => {
        const e = el as HTMLInputElement;
        return `${el.tagName.toLowerCase()}[type=${e.type ?? ""} name=${e.name ?? ""} id=${el.id}]`;
      }),
    )
    .catch(() => [] as string[]);
  paso(`captura ${nombre} — campos: ${campos.slice(0, 12).join(" ") || "(ninguno)"}`);
}

// El login con e.firma en CUALQUIER realm NAM del SAT: la página abre en modo
// CIEC y trae #buttonFiel que la cambia a subir .cer/.key sin captcha. Cada
// realm (loginc general, login.siat de CE, loginda de declaraciones) pide su
// propio login, pero los tres exponen este mismo flujo — medido en el recon.
async function loginEfirma(
  page: Page,
  cerPath: string,
  keyPath: string,
  pass: string,
  etiqueta: string,
): Promise<boolean> {
  const btn = page.locator("#buttonFiel");
  if (!(await btn.count())) {
    paso(`[${etiqueta}] no hay #buttonFiel — ¿ya autenticado o página distinta?`);
    return false;
  }
  await btn.first().click().catch(() => paso(`[${etiqueta}] no se pudo clicar #buttonFiel`));
  await page.waitForTimeout(2500);
  const files = page.locator('input[type="file"]');
  if ((await files.count()) < 2) {
    paso(`[${etiqueta}] no aparecieron los inputs de archivo`);
    return false;
  }
  await files.nth(0).setInputFiles(cerPath).catch(() => {});
  await page.waitForTimeout(600);
  await files.nth(1).setInputFiles(keyPath).catch(() => {});
  await page.waitForTimeout(800);
  // Pacing tipo humano por si el portal mirara el ritmo: la contraseña se
  // teclea carácter por carácter y se hace una pausa antes de enviar. (No creo
  // que sea la causa —el login SÍ autentica— pero descarta la variable.)
  const pwd = page.locator('input[type="password"]:visible');
  if (await pwd.count()) {
    await pwd.first().click().catch(() => {});
    await pwd.first().pressSequentially(pass, { delay: 90 }).catch(() => pwd.first().fill(pass));
  }
  await page.waitForTimeout(1200);
  await page.locator("#submit, button[type=submit], input[type=submit]").first().click().catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(4000);
  paso(`[${etiqueta}] e.firma enviada · URL ahora: ${page.url().slice(0, 80)}`);
  return true;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient();
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "fiel-"));
  const cerPath = path.join(tmpBase, "e.cer");
  const keyPath = path.join(tmpBase, "e.key");

  try {
    const c = await prisma.company.findFirst({
      where: { rfc: RFC_OBJETIVO },
      select: { fielCer: true, fielKey: true, fielPassword: true, razonSocial: true },
    });
    if (!c?.fielCer || !c?.fielKey || !c?.fielPassword) {
      throw new Error(`${RFC_OBJETIVO} sin FIEL completa en la base.`);
    }
    paso(`FIEL de ${c.razonSocial} (${RFC_OBJETIVO}) cargada`);

    // Descifrar a temporales 0600.
    fs.writeFileSync(cerPath, Buffer.from(decryptSecret(c.fielCer), "base64"), { mode: 0o600 });
    fs.writeFileSync(keyPath, Buffer.from(decryptSecret(c.fielKey), "base64"), { mode: 0o600 });
    const pass = decryptSecret(c.fielPassword);
    paso("FIEL descifrada a temporales (0600)");

    const headless = process.env.HEADED !== "1";
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      recordHar: { path: path.join(OUT, "sat.har"), content: "embed" },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    try {
      // El usuario probó que ir DIRECTO a la sección con e.firma funciona;
      // pre-loguearse en loginc dejaba una sesión cruzada que rompía la app de
      // CE (error.seg.0001). Así que NO se pre-loguea: cada sección entra por su
      // trámite, redirige a su realm, y ahí se hace el e.firma una sola vez.
      // Con PORTAL=1 se prueba el login del portal general (para CSF/Opinión).
      if (process.env.PORTAL === "1") {
        paso(`abriendo portal general ${URL_LOGIN_FIEL}`);
        await page.goto(URL_LOGIN_FIEL, { waitUntil: "networkidle" }).catch((e) => paso(`goto login: ${e.message}`));
        await shot(page, 1, "login-ciec");
        await loginEfirma(page, cerPath, keyPath, pass, "portal");
        await shot(page, 4, "post-login");
        paso(`URL portal: ${page.url()}`);
      } else {
        paso("sin pre-login de portal — cada sección hace su propio e.firma (flujo directo)");
      }

      // Recorrido de lectura. La CE consulta entra por su página de trámite,
      // que auto-POSTea al SSO (id=mat-ptsc-totp_Aviso) y, con la sesión e.firma
      // ya viva, aterriza en la app real. Se navega y se espera a que la cadena
      // de redirects se asiente para grabar la app y sus llamadas de datos.
      const secciones: [string, string][] = [
        [
          "contabilidad-electronica",
          "https://wwwmat.sat.gob.mx/operacion/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica",
        ],
      ];
      // El usuario da la secuencia real: primero el minisitio de Buzón
      // Tributario, luego la URL de CE. El minisitio es la portada desde donde
      // se entra; se visita para grabar su cadena antes de la consulta.
      paso("minisitio Buzón Tributario (portada)");
      await page
        .goto("https://www.sat.gob.mx/minisitio/BuzonTributario/index.html", { waitUntil: "domcontentloaded", timeout: 20000 })
        .catch((e) => paso(`  minisitio goto: ${e.message}`));
      await page.waitForTimeout(1500);
      await shot(page, 5, "minisitio-buzon");

      let n = 6;
      for (const [nombre, url] of secciones) {
        paso(`sección ${nombre}: ${url}`);
        await page.goto(url, { waitUntil: "networkidle" }).catch((e) => paso(`  ${nombre} goto: ${e.message}`));
        await page.waitForTimeout(4000); // deja asentar la cadena SSO
        // El realm de esta sección (login.siat) pide su PROPIO login e.firma —
        // no hereda la sesión de loginc. Si aparece #buttonFiel, re-autenticar.
        if (await page.locator("#buttonFiel").count()) {
          paso(`  ${nombre} pide login propio — re-autenticando con e.firma`);
          await loginEfirma(page, cerPath, keyPath, pass, nombre);
          await page.waitForTimeout(3000);
        }
        await shot(page, n++, nombre);
        paso(`  URL final ${nombre}: ${page.url()}`);
      }
    } finally {
      await context.close(); // vuelca el HAR
      await browser.close();
    }
    paso(`recon terminado. HAR y capturas en ${OUT}`);
  } finally {
    // La llave nunca sobrevive al proceso.
    for (const f of [cerPath, keyPath]) fs.existsSync(f) && fs.rmSync(f, { force: true });
    fs.existsSync(tmpBase) && fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.writeFileSync(path.join(OUT, "pasos.log"), log.join("\n") + "\n");
    await prisma.$disconnect();
    paso("temporales de FIEL borrados");
  }
}

main().catch((e) => {
  console.error("recon falló:", e.message);
  process.exit(1);
});
