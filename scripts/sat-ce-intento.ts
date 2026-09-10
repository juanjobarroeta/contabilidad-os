/**
 * Llega a Contabilidad Electrónica (consulta de acuses) por la PUERTA REAL.
 *
 * Arquitectura confirmada (curl + captura del navegador, 2026-09-08):
 *   GET  wwwmat.sat.gob.mx/operacion/16203/…      → 302
 *   302  wwwmat.sat.gob.mx/nesp/app/plogin?agAppNa=PTSC   (nesp = SP SAML de PTSC)
 *   302  login.siat.sat.gob.mx/nidp/idff/sso?…&AuthnContextStatementRef=…totp…
 *        → aterriza en el contrato TOTP (mat-ptsc-totp_Aviso), que NO podemos.
 *
 * PERO login.siat SÍ ofrece e.firma para PTSC: el contrato es `fiel_Aviso`
 * (capturado del botón "e.firma" de la pantalla real). Así que en cuanto caemos
 * en el realm login.siat por la vía totp, CAMBIAMOS de contrato a fiel_Aviso —
 * dentro de la MISMA sesión, que retiene el AuthnRequest del SP — servimos el
 * certform, lo firmamos con la receta probada (auth.ts) y seguimos la aserción
 * SAML de vuelta por nesp hasta la app de CE.
 *
 * Uso: source el env y correr:
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-ce-intento.ts
 *   RFC=AMA170817NK1 (MARGOM: tiene CE)   CE_URL=… para otra entrada.
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import * as https from "node:https";
import { decryptSecret } from "../src/lib/crypto";
import { extraerReto, firmarReto, cuerpoDeLogin, type FirmanteFiel } from "../src/lib/sat-portal/auth";

const RFC = process.env.RFC ?? "AMA170817NK1";
// La PUERTA REAL es /consultas/login/16203/: esa página arma el lanzador con el
// url= POBLADO (=/operacion/16203/…) y de ahí pasa por el Access Gateway
// (accesoC) → nesp → login.siat. Entrar directo a /operacion/16203/ se saltaba
// ese armado y el lanzador quedaba con url= vacío (error.seg.0001).
const CE_URL =
  process.env.CE_URL ??
  "https://wwwmat.sat.gob.mx/consultas/login/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica";
// El contrato e.firma de login.siat para PTSC (capturado del botón "e.firma").
const FIEL_CONTRATO =
  "https://login.siat.sat.gob.mx/nidp/idff/sso?id=fiel_Aviso&sid=0&option=credential";

// loginc/​login.siat negocian Diffie-Hellman débil; bajamos SECLEVEL sólo aquí.
const agente = new https.Agent({ ciphers: "DEFAULT@SECLEVEL=0", minVersion: "TLSv1.2" });

interface Resp {
  status: number;
  location: string | null;
  setCookie: string[];
  body: string;
}
function pedir(url: string, cookie: string, method = "GET", body?: string, referer?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "Accept-Language": "es-MX,es",
    };
    if (cookie) headers.Cookie = cookie;
    if (referer) headers.Referer = referer;
    if (body != null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const req = https.request(new URL(url), { method, headers, agent: agente }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          location: (res.headers.location as string) ?? null,
          setCookie: (res.headers["set-cookie"] as string[] | undefined) ?? [],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function host(u: string): string {
  return new URL(u).host;
}

// ── Frasco de cookies con DOMINIO y RUTA ──────────────────────────────────────
// Las cookies de afinidad del F5 (IPCZQX…, F5-CONTENCION…) vienen con
// Domain=.sat.gob.mx: DEBEN mandarse a wwwmat Y a login.siat. Un frasco por-host
// las aislaba y rompía la pegajosidad del balanceador → la sesión federada se
// perdía al volver a accesoC (bucle de re-login). Aquí se respeta domain/path.
interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
}
type Jar = Cookie[];

function rutaPorDefecto(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const i = pathname.lastIndexOf("/");
  return i <= 0 ? "/" : pathname.slice(0, i);
}

function guardar(jar: Jar, urlStr: string, setCookie: string[]) {
  const u = new URL(urlStr);
  for (const sc of setCookie) {
    const partes = sc.split(";");
    const par = partes[0];
    const i = par.indexOf("=");
    if (i <= 0) continue;
    const name = par.slice(0, i).trim();
    const value = par.slice(i + 1).trim();
    let domain = u.host.toLowerCase();
    let hostOnly = true;
    let path = rutaPorDefecto(u.pathname);
    for (const attr of partes.slice(1)) {
      const eq = attr.indexOf("=");
      const k = (eq > 0 ? attr.slice(0, eq) : attr).trim().toLowerCase();
      const v = eq > 0 ? attr.slice(eq + 1).trim() : "";
      if (k === "domain" && v) {
        domain = v.replace(/^\./, "").toLowerCase();
        hostOnly = false;
      } else if (k === "path" && v) {
        path = v;
      }
    }
    const idx = jar.findIndex((c) => c.name === name && c.domain === domain && c.path === path);
    if (idx >= 0) jar.splice(idx, 1); // upsert por (domain, path, name)
    jar.push({ name, value, domain, hostOnly, path });
  }
}

function dominioCoincide(h: string, c: Cookie): boolean {
  return c.hostOnly ? h === c.domain : h === c.domain || h.endsWith("." + c.domain);
}
function rutaCoincide(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || pathname[cookiePath.length] === "/";
}
function cookieDe(jar: Jar, urlStr: string): string {
  const u = new URL(urlStr);
  return jar
    .filter((c) => dominioCoincide(u.host.toLowerCase(), c) && rutaCoincide(u.pathname, c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** ¿La página es un form que se auto-envía (aviso NetIQ, o POST de SAMLResponse)? */
function formAutoSubmit(html: string, base: string): { action: string; method: string; body: string } | null {
  if (!/\.submit\(\)/.test(html)) return null;
  const form = /<form\b[\s\S]*?<\/form>/i.exec(html)?.[0];
  if (!form) return null;
  const tag = /<form\b[^>]*>/i.exec(form)?.[0] ?? "";
  const action = /action=["']([^"']*)["']/i.exec(tag)?.[1] || base;
  const method = /method=["']?post/i.test(tag) ? "POST" : "GET";
  const p = new URLSearchParams();
  for (const inp of form.match(/<input\b[^>]*>/gi) ?? []) {
    const name = /name=["']([^"']*)["']/i.exec(inp)?.[1];
    if (name) p.set(name, /value=["']([^"']*)["']/i.exec(inp)?.[1] ?? "");
  }
  return { action: new URL(action, base).toString(), method, body: p.toString() };
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

  const jar: Jar = [];
  let url = CE_URL;
  let method = "GET";
  let body: string | undefined;
  let referer: string | undefined;
  let fielSwitched = false;
  let logins = 0;

  const visto = new Map<string, number>();
  for (let hop = 0; hop < 25; hop++) {
    const h = host(url);
    // Guarda-bucle: la 2ª visita a accesoC es LEGÍTIMA (ya federados, ahora sirve
    // el buzón en vez de rebotar al login). Sólo cortamos en la 3ª — ésa sí es
    // bucle real (una app que se re-postea a sí misma sin avanzar).
    const clave = `${method} ${url}`;
    const n = (visto.get(clave) ?? 0) + 1;
    visto.set(clave, n);
    if (n >= 3) {
      console.log(`\n■ Bucle real (${clave.slice(0, 56)}… ×${n}). Body → ce-hop${hop - 1}.html`);
      return;
    }
    const r = await pedir(url, cookieDe(jar, url), method, body, referer);
    guardar(jar, url, r.setCookie);
    referer = url;

    // Volcar cada salto para diagnóstico offline (sin re-pegarle al SAT).
    { const fs = await import("node:fs"); try { fs.writeFileSync(`${process.env.CLAUDE_JOB_DIR ?? "/tmp"}/tmp/ce-hop${hop}.html`, r.body); } catch { /* noop */ } }

    const err = (/error\.seg\.\d+/.exec(r.body) || /error\.seg\.\d+/.exec(url))?.[0];
    // El certform REAL trae los campos del applet (urlApplet/privateKeyPassword/
    // txtCertificate). Un "aviso" NetIQ también puede traer name="guid" pero NO
    // esos campos: a ese hay que SEGUIRLO (auto-submit), no firmarlo.
    const certform = /name=["']guid["']/i.test(r.body) && /urlApplet|privateKeyPassword|txtCertificate/i.test(r.body);
    const auto = formAutoSubmit(r.body, url);
    const jsLoc =
      /(?:window|top|self|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(r.body)?.[1] ||
      /location\.replace\(\s*["']([^"']+)["']/i.exec(r.body)?.[1] ||
      // La página /consultas/login/… hace `window.location=goto`, con `goto`
      // asignado a la URL del lanzador (url= poblado). Resolver la variable.
      (/(?:window|top|self)\.location\s*=\s*goto\b/i.test(r.body)
        ? /\bgoto\s*=\s*["']([^"']+)["']/i.exec(r.body)?.[1]
        : undefined);
    const ceMark = /consulta.*acuse|acuses?\s+generad|balanza\s+de\s+comprobaci|cat[aá]logo\s+de\s+cuentas|env[ií]o.*contabilidad/i.test(r.body);
    const flags = [certform && "certform", auto && "auto-submit", jsLoc && "js-redirect", err && `⚠${err}`, ceMark && "★CE-marker"]
      .filter(Boolean).join(" ");
    console.log(`[${hop}] ${r.status} ${method} ${h}${new URL(url).pathname.slice(0, 42)}  ${flags}`);
    if (process.env.COOKIES) {
      const setc = r.setCookie.map((c) => c.split("=")[0].trim()).join(",") || "-";
      const enviadas = cookieDe(jar, url).split("; ").map((s) => s.split("=")[0]).filter(Boolean).join(",") || "-";
      console.log(`      envié{${enviadas}}  set:[${setc}]` + (r.location ? `  →${new URL(r.location, url).host}${new URL(r.location, url).pathname.slice(0, 34)}` : ""));
    }
    method = "GET";
    body = undefined;

    // 1) certform → firmar e.firma y postear el sobre
    if (certform && logins < 2) {
      logins++;
      const reto = extraerReto(r.body, url);
      const sobre = firmarReto(reto, firmante);
      method = "POST";
      body = cuerpoDeLogin(reto, sobre);
      url = reto.actionUrl;
      console.log(`     → firmo e.firma en ${h} (guid ${reto.guid.slice(0, 10)}…) y posteo`);
      continue;
    }
    // 2) caímos en login.siat por la vía TOTP → cambiar al contrato e.firma
    if (h.includes("login.siat") && !fielSwitched && /totp/i.test(url + " " + r.body)) {
      fielSwitched = true;
      url = FIEL_CONTRATO;
      console.log(`     → cambio de contrato TOTP → e.firma (${FIEL_CONTRATO.slice(0, 62)}…)`);
      continue;
    }
    // 3) página que se auto-envía (aviso NetIQ / POST de SAMLResponse) → seguirla
    if (auto) {
      url = auto.action;
      method = auto.method;
      body = auto.body;
      continue;
    }
    // 4) redirect normal
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url).toString();
      continue;
    }
    // 4b) redirect por JavaScript (window.location / location.replace)
    if (jsLoc) {
      url = new URL(jsLoc, url).toString();
      console.log(`     → JS redirect a ${host(url)}${new URL(url).pathname.slice(0, 40)}`);
      continue;
    }
    // 5) terminal
    const fs = await import("node:fs");
    const out = `${process.env.CLAUDE_JOB_DIR ?? "/tmp"}/tmp/ce-final.html`;
    try { fs.writeFileSync(out, r.body); } catch { /* best-effort */ }
    if (r.status === 503 || /Servicio no disponible|please try later|Access Gateway/i.test(r.body)) {
      console.log(`\n⏳ 503 Access Gateway ("intente más tarde") en ${h}${new URL(url).pathname.slice(0, 30)}. SAT throttling — espaciar y reintentar. Body → ${out}`);
    } else if (ceMark) {
      console.log(`\n✅ ¡CE! URL final: ${url}\n  (menciona acuses/balanza/catálogo). Body → ${out}`);
    } else if (err) {
      console.log(`\n❌ ${err}: login entró pero la app pierde el target. Body → ${out}`);
    } else {
      const titulo = /<title[^>]*>([^<]*)<\/title>/i.exec(r.body)?.[1]?.trim();
      console.log(`\n? Fin sin marcador CE. ${r.status} · «${titulo ?? "?"}» · ${r.body.length}b → ${out}`);
    }
    return;
  }
  console.log("\n⚠ Se agotaron los saltos sin aterrizar.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
