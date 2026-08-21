// ─────────────────────────────────────────────────────────────────────────────
// Sesión autenticada al portal del SAT — el orquestador de auth.ts contra la
// red real. Toma la FIEL de una empresa, resuelve el reto-respuesta y deja una
// sesión (cookie) con la que las capas de declaraciones y CE piden sus páginas.
//
// LO QUE FALTA CONFIRMAR CON UNA CAPTURA. Las URLs de abajo son las públicas y
// conocidas del portal, pero el flujo exacto —cuántos redirects, qué campos
// extra pide el formulario, cómo se llama la cookie de sesión— sólo se fija con
// UNA captura real (ver docs/sat-portal-captura.md). Hasta tenerla, iniciar
// sesión lanza SatPortalCapturaPendiente en vez de adivinar contra el portal
// vivo con la credencial de un cliente. La firma (auth.ts) ya está probada y no
// cambia con la captura.
// ─────────────────────────────────────────────────────────────────────────────
import {
  extraerReto,
  firmarReto,
  cuerpoDeLogin,
  extraerCookieSesion,
  SatPortalAuthError,
  type FirmanteFiel,
} from "./auth";

/** URL de arranque del login con e.firma. A confirmar con captura. */
const URL_LOGIN_FIEL = "https://loginc.mat.sat.gob.mx/nidp/app/login?id=fiel";

export interface SesionSat {
  /** Header `Cookie` para las peticiones autenticadas siguientes. */
  cookie: string;
  rfc: string;
}

/** El `fetch` se inyecta para poder correr contra fixtures en las pruebas. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface AbrirSesionOpts {
  fetchFn?: FetchFn;
  /** El firmante ya cargado (getFielForCompany). */
  firmante: FirmanteFiel;
  urlLogin?: string;
}

/**
 * Abre una sesión: GET a la página de login → extrae el reto → lo firma →
 * POST del sobre → lee la cookie. Cada paso falla ruidosamente: un 200 sin
 * cookie es un login rechazado, no una sesión.
 */
export async function abrirSesionSat(opts: AbrirSesionOpts): Promise<SesionSat> {
  if (!CAPTURA_LISTA) {
    throw new SatPortalCapturaPendiente();
  }
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchFn);
  const urlLogin = opts.urlLogin ?? URL_LOGIN_FIEL;

  const pagina = await fetchFn(urlLogin, { headers: { Accept: "text/html" } });
  const html = await pagina.text();
  const reto = extraerReto(html, urlLogin);

  const sobre = firmarReto(reto, opts.firmante);
  const resLogin = await fetchFn(reto.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      Cookie: cookieDe(pagina),
    },
    body: cuerpoDeLogin(sobre),
    redirect: "manual",
  });

  const cookie = extraerCookieSesion(setCookieDe(resLogin));
  if (!cookie) {
    throw new SatPortalAuthError(
      `El SAT no entregó sesión para RFC ${opts.firmante.rfc()}: login rechazado ` +
        `(¿FIEL revocada, o cambió el formulario del portal?).`,
    );
  }
  return { cookie, rfc: opts.firmante.rfc() };
}

// Interruptor: se pone en true cuando la captura confirmó URLs y campos. Hasta
// entonces la sesión no toca el portal — sólo la firma, que ya está probada,
// corre en las pruebas.
const CAPTURA_LISTA = false;

export class SatPortalCapturaPendiente extends Error {
  constructor() {
    super(
      "La automatización del portal SAT necesita una captura del flujo real " +
        "de login antes de correr en vivo. Ver docs/sat-portal-captura.md.",
    );
    this.name = "SatPortalCapturaPendiente";
  }
}

function cookieDe(res: Response): string {
  return extraerCookieSesion(setCookieDe(res)) ?? "";
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
