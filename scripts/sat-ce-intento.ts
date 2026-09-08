/**
 * Intento de llegar a Contabilidad Electrónica CON la sesión de loginc ya viva.
 * Abre la sesión (auth.ts + session.ts), luego pide la URL de CE y SIGUE la
 * cadena de redirects federando contra loginc con las cookies vivas, con un
 * frasco de cookies POR DOMINIO. Reporta dónde aterriza: la app de CE o el
 * error.seg.0001 (que diría que la entrada operacion/16203 pierde el target).
 *
 * Uso: DATABASE_URL=<url> CREDENTIALS_ENCRYPTION_KEY=<k> [RFC=AMA170817NK1] [CE_URL=..] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-ce-intento.ts
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import * as https from "node:https";
import { decryptSecret } from "../src/lib/crypto";
import { extraerReto, firmarReto, cuerpoDeLogin, type FirmanteFiel } from "../src/lib/sat-portal/auth";

const RFC = process.env.RFC ?? "AMA170817NK1"; // MARGOM: tiene CE
const CE_URL =
  process.env.CE_URL ??
  "https://wwwmat.sat.gob.mx/operacion/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica";

const agente = new https.Agent({ ciphers: "DEFAULT@SECLEVEL=0", minVersion: "TLSv1.2" });

interface Resp {
  status: number;
  location: string | null;
  setCookie: string[];
  body: string;
  url: string;
}
function pedir(url: string, cookie: string, method = "GET", body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: "text/html", "User-Agent": "Mozilla/5.0" };
    if (cookie) headers.Cookie = cookie;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const req = https.request(new URL(url), { method, headers, agent: agente }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          location: (res.headers.location as string) ?? null,
          setCookie: (res.headers["set-cookie"] as string[] | undefined) ?? [],
          body: Buffer.concat(chunks).toString("utf8"),
          url,
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function dominio(u: string): string {
  return new URL(u).host;
}
function guardar(jars: Map<string, Map<string, string>>, host: string, setCookie: string[]) {
  const jar = jars.get(host) ?? new Map<string, string>();
  for (const c of setCookie) {
    const [par] = c.split(";");
    const i = par.indexOf("=");
    if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  jars.set(host, jar);
}
function cookieDe(jars: Map<string, Map<string, string>>, host: string): string {
  const jar = jars.get(host);
  return jar ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}

async function main() {
  const prisma = new PrismaClient();
  const c = await prisma.company.findFirst({
    where: { rfc: RFC },
    select: { rfc: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  await prisma.$disconnect();
  const cerDer = Buffer.from(decryptSecret(c!.fielCer!), "base64");
  const keyDer = Buffer.from(decryptSecret(c!.fielKey!), "base64");
  const pass = decryptSecret(c!.fielPassword!);
  const x509 = new crypto.X509Certificate(cerDer);
  const priv = crypto.createPrivateKey({ key: keyDer, format: "der", type: "pkcs8", passphrase: pass });
  const serial = Buffer.from(x509.serialNumber, "hex").toString("ascii");
  const p2 = (n: number) => String(n).padStart(2, "0");
  const d = new Date(x509.validTo);
  const fert = p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + "Z";
  const firmante: FirmanteFiel = {
    sign: (data, algo = "sha1") => crypto.sign(algo === "sha256" ? "sha256" : "sha1", Buffer.from(data, "utf8"), priv).toString("binary"),
    rfc: () => c!.rfc!,
    certificate: () => ({ pemAsOneLine: () => "", serialNumber: () => ({ decimal: () => serial }), validTo: () => fert }),
  };

  // Flujo SP-initiated hacia CE: seguir redirects y, cuando aparezca el certform
  // (en el realm que sea — login.siat para CE), FIRMAR ahí con la e.firma.
  const jars = new Map<string, Map<string, string>>();
  console.log(`Yendo a CE (SP-initiated, se firma en el realm que lo pida):\n  ${CE_URL}`);
  let url = CE_URL;
  let method = "GET";
  let body: string | undefined;
  let logins = 0;
  for (let hop = 0; hop < 20; hop++) {
    const host = dominio(url);
    const r = await pedir(url, cookieDe(jars, host), method, body);
    guardar(jars, host, r.setCookie);
    const err = (/error\.seg\.\d+/.exec(r.body) || /error\.seg\.\d+/.exec(url))?.[0];
    const certform = /name="guid"/.test(r.body) && /credentialsRequired|certform/.test(r.body);
    console.log(`  [${hop}] ${r.status} ${method} ${url.slice(0, 70)}` + (err ? `  ⚠ ${err}` : "") + (certform ? "  · certform" : ""));
    body = undefined;
    method = "GET";
    if (certform && logins < 2) {
      logins++;
      const reto = extraerReto(r.body, url);
      const sobre = firmarReto(reto, firmante);
      method = "POST";
      body = cuerpoDeLogin(reto, sobre); // certform sin action → POST al mismo url
      console.log(`      → e.firma en ${host} (guid ${reto.guid.slice(0, 10)}…)`);
      continue;
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url).toString();
      continue;
    }
    if (err) {
      console.log(`\n❌ ${err}: el LOGIN entró, pero la ENTRADA de CE pierde el target (url= vacío). Falta la URL correcta de la app de CE.`);
    } else if (/consulta.*acuse|balanza de comprobaci|cat[aá]logo de cuentas|folio.*acuse|env[ií]os.*contabilidad/i.test(r.body)) {
      console.log(`\n✅ ¡CE! URL final: ${url}\n  (menciona acuses/balanza/catálogo — es la app de Contabilidad Electrónica)`);
    } else {
      console.log(`\n? Fin sin marcadores. URL ${url} · ${r.status} · body ${r.body.length}b`);
    }
    break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
