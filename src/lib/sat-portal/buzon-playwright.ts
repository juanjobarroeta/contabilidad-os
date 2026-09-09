// ─────────────────────────────────────────────────────────────────────────────
// Sesión autenticada al Buzón Tributario del SAT con NAVEGADOR REAL (Playwright).
//
// POR QUÉ UN NAVEGADOR Y NO HTTP PURO. El buzón vive detrás del NetIQ Access
// Gateway + F5: tras federar con la e.firma, el gateway emite un `idSessionBit`
// que hay que sostener con las cookies exactas. Un cliente HTTP a mano entraba
// en bucle (accesoC→plogin); un navegador de verdad lo maneja solo. El login
// e.firma se probó BYTE-IDÉNTICO contra la descarga manual (ver scripts/).
//
// ESTA CAPA SÓLO AUTENTICA. Entrega una página ya dentro del buzón; cada fuente
// (CE, declaraciones, CSF…) se construye encima con `abrirBuzonSat(fiel, fn)`.
//
// DESPLIEGUE: requiere Chromium instalado (playwright install chromium) y ~512MB
// de RAM por navegador. No corre en el build por defecto de Railway (sin
// Chromium): va en un worker/cron dedicado, no en la ruta del app.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { prisma } from "../prisma";
import { decryptSecret } from "../crypto";

/** Los bytes crudos de la e.firma que el JS del SAT firma en el navegador. */
export interface FielBytes {
  rfc: string;
  cerDer: Buffer;
  keyDer: Buffer;
  pass: string;
}

/** El buzón de esa cuenta no dejó entrar (típico: no habilitado, o e.firma incompleta). */
export class BuzonAccesoError extends Error {
  constructor(rfc: string, motivo: string) {
    super(`Buzón SAT ${rfc}: ${motivo}`);
    this.name = "BuzonAccesoError";
  }
}

const ENTRADA = "https://wwwmat.sat.gob.mx/app/seg/cont/accesoC?url=/buzon&idSessionBit=0";
const EN_BUZON = /wwwmat\.sat\.gob\.mx\/(buzon|operacion)/;

/** Carga y descifra la e.firma de la empresa (mismo patrón que sat-fiel.ts). */
export async function getFielBytes(companyId: string): Promise<FielBytes> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  if (!c?.rfc || !c.fielCer || !c.fielKey || !c.fielPassword) {
    throw new BuzonAccesoError(c?.rfc ?? companyId, "sin e.firma completa");
  }
  return {
    rfc: c.rfc,
    cerDer: Buffer.from(decryptSecret(c.fielCer), "base64"),
    keyDer: Buffer.from(decryptSecret(c.fielKey), "base64"),
    pass: decryptSecret(c.fielPassword),
  };
}

export interface AbrirBuzonOpts {
  headless?: boolean;
  log?: (msg: string) => void;
}

/**
 * Abre una sesión del Buzón Tributario con la e.firma y ejecuta `fn` con la
 * página ya autenticada. Cierra el navegador y borra los archivos temporales de
 * la FIEL pase lo que pase.
 *
 * Login (flujo del navegador real, probado): accesoC?url=/buzon → login.siat →
 * `#buttonFiel` (contrato fiel_Aviso, carga el certform) → sube .cer/.key a
 * `#fileCertificate`/`#filePrivateKey`, contraseña en `#privateKeyPassword`,
 * pulsa `#submit` (dispara `firmar()`, que firma con el JS del SAT: sjcl +
 * jsrsasign) → aterriza en /buzon?idSessionBit=<real>. Lanza BuzonAccesoError si
 * el gateway no autoriza (403 típico de cuentas sin buzón habilitado).
 */
export async function abrirBuzonSat<T>(
  fiel: FielBytes,
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
  opts: AbrirBuzonOpts = {},
): Promise<T> {
  const log = opts.log ?? (() => {});
  const browser = await chromium.launch({
    headless: opts.headless ?? true,
    args: ["--ignore-certificate-errors"],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fiel-${fiel.rfc}-`));
  const cerPath = path.join(dir, "e.cer");
  const keyPath = path.join(dir, "e.key");
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
    const page = await ctx.newPage();

    // El certform a veces llega lento (card de login del SAT). Espéralo
    // ACTIVAMENTE y reintenta la navegación un par de veces antes de rendirse —
    // evita fallos transitorios en el barrido de cartera.
    let certform = false;
    for (let intento = 1; intento <= 3 && !certform; intento++) {
      await page.goto(ENTRADA, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      // Tab e.firma: #buttonFiel navega al contrato fiel_Aviso, que sirve el certform.
      await page.locator("#buttonFiel").click({ timeout: 8000 }).catch(() => {});
      certform = await page
        .locator("#fileCertificate")
        .waitFor({ state: "attached", timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!certform) {
        log(`certform no apareció (intento ${intento}/3)`);
        await page.waitForTimeout(2000);
      }
    }
    if (!certform) {
      throw new BuzonAccesoError(
        fiel.rfc,
        "no apareció el certform de e.firma tras 3 intentos (¿SAT lento/throttling, o cambió el login?)",
      );
    }

    fs.writeFileSync(cerPath, fiel.cerDer);
    fs.writeFileSync(keyPath, fiel.keyDer);
    await page.locator("#fileCertificate").setInputFiles(cerPath);
    await page.locator("#filePrivateKey").setInputFiles(keyPath);
    await page.locator("#privateKeyPassword").fill(fiel.pass);
    await page.locator("#submit").click({ timeout: 8000 }).catch(() =>
      page.evaluate(() => (document.getElementById("submit") as HTMLElement | null)?.click()),
    );
    await page.waitForURL((u) => EN_BUZON.test(String(u)), { timeout: 45000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    if (!EN_BUZON.test(page.url())) {
      throw new BuzonAccesoError(
        fiel.rfc,
        `el gateway no autorizó (¿buzón no habilitado? url=${page.url().slice(0, 80)})`,
      );
    }
    log(`buzón autenticado (${fiel.rfc})`);
    return await fn(page, ctx);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await browser.close().catch(() => {});
  }
}
