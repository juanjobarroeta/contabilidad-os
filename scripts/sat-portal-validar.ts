/**
 * Valida el login del portal SAT en dos modos:
 *   (default) REPRODUCE — offline, sin tocar al SAT: firma el `guid` capturado en
 *     el HAR con la FIEL real y comprueba que el `token` resultante es
 *     BYTE-IDÉNTICO al que mandó el navegador. Si empata, la receta + el firmante
 *     son exactos y el login en vivo funcionará.
 *   LIVE=1 — corrida supervisada: abrirSesionSat() contra loginc de verdad.
 *
 * Uso: DATABASE_URL=<url> CREDENTIALS_ENCRYPTION_KEY=<k> [LIVE=1] [HAR=ruta] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-portal-validar.ts
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as fs from "node:fs";
import { decryptSecret } from "../src/lib/crypto";
import { firmarReto, type FirmanteFiel } from "../src/lib/sat-portal/auth";
import { abrirSesionSat, type FetchFn } from "../src/lib/sat-portal/session";

// El servidor de loginc negocia Diffie-Hellman con parámetros DÉBILES que el
// OpenSSL de Node rechaza por default ("dh key too small"). El navegador los
// tolera; para HTTP puro bajamos el nivel de seguridad SÓLO para esta conexión.
const agenteDebil = new https.Agent({ ciphers: "DEFAULT@SECLEVEL=0", minVersion: "TLSv1.2" });

const fetchDebil = ((url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      new URL(url),
      { method: init.method ?? "GET", headers: init.headers ?? {}, agent: agenteDebil },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              getSetCookie: () => (res.headers["set-cookie"] as string[] | undefined) ?? [],
              get: (n: string) => {
                const v = res.headers[n.toLowerCase()];
                return Array.isArray(v) ? v.join(", ") : (v ?? null);
              },
            },
            text: async () => body,
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  })) as unknown as FetchFn;

const RFC = process.env.RFC ?? "AMA170817NK1";

function fert(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
  );
}

async function main() {
  const prisma = new PrismaClient();
  const c = await prisma.company.findFirst({
    where: { rfc: RFC },
    select: { rfc: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  await prisma.$disconnect();
  if (!c?.fielCer || !c?.fielKey || !c?.fielPassword) throw new Error(`${RFC} sin FIEL completa.`);

  const cerDer = Buffer.from(decryptSecret(c.fielCer), "base64");
  const keyDer = Buffer.from(decryptSecret(c.fielKey), "base64");
  const pass = decryptSecret(c.fielPassword);
  const x509 = new crypto.X509Certificate(cerDer);
  const priv = crypto.createPrivateKey({ key: keyDer, format: "der", type: "pkcs8", passphrase: pass });
  const serial = Buffer.from(x509.serialNumber, "hex").toString("ascii");
  const vigencia = fert(new Date(x509.validTo));

  const firmante: FirmanteFiel = {
    sign: (data, algo = "sha1") =>
      crypto.sign(algo === "sha256" ? "sha256" : "sha1", Buffer.from(data, "utf8"), priv).toString("binary"),
    rfc: () => c.rfc!,
    certificate: () => ({
      pemAsOneLine: () => "",
      serialNumber: () => ({ decimal: () => serial }),
      validTo: () => vigencia,
    }),
  };

  if (process.env.LIVE === "1") {
    console.log(`LIVE: abriendo sesión en loginc para ${RFC}…`);
    const s = await abrirSesionSat({ firmante, fetchFn: fetchDebil, log: (m) => console.log("  " + m) });
    console.log(`✅ SESIÓN VIVA — cookie ${s.cookie.slice(0, 55)}…  rfc ${s.rfc}`);
    return;
  }

  // REPRODUCE: reconstruir el token del HAR con el guid capturado.
  const har = JSON.parse(fs.readFileSync(process.env.HAR ?? "tmp/recon-sat-login/sat.har", "utf8"));
  let harToken = "";
  let guid = "";
  for (const e of har.log.entries) {
    if (e.request.url.includes("XACCertiSAT") && e.request.method === "POST") {
      for (const p of e.request.postData?.params ?? []) {
        if (p.name === "token") harToken = p.value;
        if (p.name === "guid") guid = p.value;
      }
    }
  }
  const sobre = firmarReto(
    { guid, urlApplet: "", credentialsRequired: "CERT", ks: "null", actionUrl: "x" },
    firmante,
  );
  console.log("serial:", serial, "· fert:", vigencia);
  console.log("token == HAR:", sobre.token === harToken ? "✅ MATCH byte-exacto" : "❌ DIFIEREN");
  if (sobre.token !== harToken) {
    console.log("  reproducido:", sobre.token.slice(0, 64));
    console.log("  del HAR:    ", harToken.slice(0, 64));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
