// ─────────────────────────────────────────────────────────────────────────────
// Sesión autenticada al portal del SAT — orquesta auth.ts contra el flujo REAL
// del IdP (loginc, NetIQ Access Manager), mapeado con captura (HAR de
// recon-sat-portal PORTAL=1, 2026-09). El login IDP-initiated deja una sesión
// viva en loginc; las apps (CE, CSF…) federan contra ella. Flujo confirmado:
//
//   GET  /nidp/jsp/main.jsp?id=FormCertiSAT   → JSESSIONID inicial (página CIEC)
//   GET  /nidp/app/login?id=XACCertiSAT       → el certform e.firma (guid, urlApplet)
//   POST /nidp/app/login?id=XACCertiSAT       → sobre firmado → JSESSIONID autenticado
//   GET  /nidp/portal                         → portal autenticado (confirma la sesión)
//
// La firma (auth.ts) está probada offline y VERIFICADA contra la firma real
// capturada (scripts/sat-login-verify.ts). El cert NO se manda: el SAT lo busca
// por el RFC/serie que van dentro del token.
// ─────────────────────────────────────────────────────────────────────────────
import {
  extraerReto,
  firmarReto,
  cuerpoDeLogin,
  SatPortalAuthError,
  type FirmanteFiel,
} from "./auth";

const LOGINC = "https://loginc.mat.sat.gob.mx";
const URL_CIEC = `${LOGINC}/nidp/jsp/main.jsp?id=FormCertiSAT&sid=0`;
const URL_CERTFORM = `${LOGINC}/nidp/app/login?id=XACCertiSAT&sid=0&option=credential`;
const URL_PORTAL = `${LOGINC}/nidp/portal`;

export interface SesionSat {
  /** Header `Cookie` para las peticiones autenticadas siguientes. */
  cookie: string;
  rfc: string;
}

/** El `fetch` se inyecta para poder correr contra fixtures en las pruebas. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface AbrirSesionOpts {
  fetchFn?: FetchFn;
  /** El firmante ya cargado (getFirmanteForCompany). */
  firmante: FirmanteFiel;
  /** Log opcional de diagnóstico paso a paso. */
  log?: (msg: string) => void;
}

/**
 * Abre una sesión en loginc con la e.firma y devuelve la cookie autenticada.
 * Cada paso falla ruidosamente: si el portal final aún pide login, la sesión no
 * se estableció (login rechazado — ¿FIEL revocada, o cambió el formulario?).
 */
export async function abrirSesionSat(opts: AbrirSesionOpts): Promise<SesionSat> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchFn);
  const log = opts.log ?? (() => {});
  const jar = new Map<string, string>();

  // 1. Página inicial → JSESSIONID.
  const r0 = await fetchFn(URL_CIEC, { headers: { Accept: "text/html" }, redirect: "manual" });
  guardarCookies(jar, r0);
  log(`1) CIEC ${r0.status} · cookies=${jar.size}`);

  // 2. Formulario e.firma (XACCertiSAT) → el reto (guid, urlApplet).
  const rForm = await fetchFn(URL_CERTFORM, {
    headers: { Accept: "text/html", Cookie: headerCookie(jar) },
    redirect: "manual",
  });
  guardarCookies(jar, rForm);
  const html = await rForm.text();
  const reto = extraerReto(html, URL_CERTFORM);
  log(`2) certform ${rForm.status} · guid=${reto.guid.slice(0, 12)}…`);

  // 3. Firmar el reto (guid|RFC|serie, RSA-SHA1) y postear el sobre.
  const sobre = firmarReto(reto, opts.firmante);
  const rLogin = await fetchFn(reto.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      Cookie: headerCookie(jar),
    },
    body: cuerpoDeLogin(reto, sobre),
    redirect: "manual",
  });
  guardarCookies(jar, rLogin);
  log(`3) POST login ${rLogin.status} · cookies=${jar.size}`);

  // 4. Confirmar: el portal autenticado NO debe volver a servir el login.
  const rPortal = await fetchFn(URL_PORTAL, {
    headers: { Accept: "text/html", Cookie: headerCookie(jar) },
    redirect: "manual",
  });
  guardarCookies(jar, rPortal);
  const portalHtml = rPortal.status === 200 ? await rPortal.text() : "";
  const cookie = headerCookie(jar);
  const autenticado =
    rPortal.status === 200 &&
    !/id=FormCertiSAT|Ecom_User_ID|buttonFiel|iniciar sesi/i.test(portalHtml);
  log(`4) portal ${rPortal.status} · autenticado=${autenticado}`);

  if (!cookie || !autenticado) {
    throw new SatPortalAuthError(
      `El SAT no dejó sesión viva para RFC ${opts.firmante.rfc()}: el portal sigue ` +
        `pidiendo login (¿FIEL revocada/expirada, o cambió el certform?).`,
    );
  }
  return { cookie, rfc: opts.firmante.rfc() };
}

function guardarCookies(jar: Map<string, string>, res: Response): void {
  const sc = setCookieDe(res);
  if (!sc) return;
  for (const c of sc) {
    const par = c.split(";")[0];
    const eq = par.indexOf("=");
    if (eq > 0) jar.set(par.slice(0, eq).trim(), par.slice(eq + 1).trim());
  }
}

function headerCookie(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** `getSetCookie` cuando existe (Node 18.14+/undici); si no, el header simple. */
function setCookieDe(res: Response): string[] | null {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    const all = h.getSetCookie();
    return all.length > 0 ? all : null;
  }
  const one = res.headers.get("set-cookie");
  return one ? [one] : null;
}
