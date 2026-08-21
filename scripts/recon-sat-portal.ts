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

const RFC_OBJETIVO = "ZIO190321JI6"; // ZIONX
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
      paso(`abriendo ${URL_LOGIN_FIEL}`);
      await page.goto(URL_LOGIN_FIEL, { waitUntil: "networkidle" }).catch((e) =>
        paso(`goto login: ${e.message}`),
      );
      await shot(page, 1, "login-ciec");

      // La página abre en modo CIEC (RFC/contraseña/captcha) y trae un botón
      // "e.firma" (#buttonFiel) que la CAMBIA a subir .cer/.key sin captcha.
      // Se hace clic y se deja correr el JS que revela los inputs de archivo.
      const btnFiel = page.locator("#buttonFiel");
      if (await btnFiel.count()) {
        await btnFiel.first().click().catch(() => paso("no se pudo clicar #buttonFiel"));
        await page.waitForTimeout(2500);
        paso("clic en e.firma (#buttonFiel)");
      } else {
        paso("no apareció #buttonFiel — ¿cambió la página de login?");
      }
      await shot(page, 2, "efirma-form");

      const inputs = await page.locator('input[type="file"]').count();
      paso(`inputs de archivo tras el clic: ${inputs}`);
      if (inputs >= 2) {
        const files = page.locator('input[type="file"]');
        await files.nth(0).setInputFiles(cerPath).catch(() => paso("no subió .cer al input 0"));
        await files.nth(1).setInputFiles(keyPath).catch(() => paso("no subió .key al input 1"));
        // En modo e.firma la contraseña es la de la LLAVE, no la CIEC.
        const pwd = page.locator('input[type="password"]:visible');
        if (await pwd.count()) await pwd.first().fill(pass);
        await shot(page, 3, "efirma-lleno");
        paso("archivos y contraseña de la llave puestos; enviando");
        await page.locator("#submit, button[type=submit], input[type=submit]").first().click().catch(() =>
          paso("no se encontró botón de envío"),
        );
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(4000);
      } else {
        paso("los inputs de archivo no aparecieron tras el clic — revisar 02-efirma-form.html");
      }
      await shot(page, 4, "post-login");
      paso(`URL tras login: ${page.url()}`);

      // Recorrido de lectura por las tres fuentes. Cada goto es sólo navegar.
      const secciones: [string, string][] = [
        ["declaraciones", "https://ptscdecprov.clouda.sat.gob.mx/"],
        ["contabilidad-electronica", "https://buzon.sat.gob.mx/"],
        ["csf-opinion", "https://loginc.mat.sat.gob.mx/nidp/portal"],
      ];
      let n = 5;
      for (const [nombre, url] of secciones) {
        paso(`sección ${nombre}: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => paso(`  ${nombre} goto: ${e.message}`));
        await page.waitForTimeout(3000);
        await shot(page, n++, nombre);
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
