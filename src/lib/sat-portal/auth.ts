// ─────────────────────────────────────────────────────────────────────────────
// Autenticación al portal del SAT con la e.firma (FIEL).
//
// POR QUÉ FIEL Y NO CIEC. El portal admite dos maneras de entrar: la CIEC
// (usuario/contraseña) que trae CAPTCHA, y la e.firma que NO — porque la prueba
// de identidad es una firma criptográfica, no un humano resolviendo imágenes.
// Elegir FIEL nos evita toda la infraestructura de resolver captchas, que es la
// parte frágil de cualquier scraper de portal. Además ya guardamos la FIEL de
// cada empresa cifrada (para la descarga masiva), así que no hay credencial
// nueva ni consentimiento nuevo que pedir.
//
// CÓMO FUNCIONA EL RETO-RESPUESTA. El SAT sirve una página de login que embebe
// un "tokenValue" (el reto). Se FIRMA ese token con la llave privada de la
// FIEL; se arma un sobre con el reto, la firma en base64, el certificado y su
// número de serie; se postea; y el SAT devuelve una cookie de sesión que
// autoriza las páginas siguientes. Esta capa NO conoce Declaraciones ni CE:
// sólo entrega una sesión autenticada. Cada fuente se construye encima.
//
// ESTA CAPA ES 100% OFFLINE Y TESTEABLE. La firma se prueba contra un
// certificado autofirmado de prueba (nunca una FIEL real) y el sobre se arma a
// partir de un reto capturado, sin tocar la red. La validación contra el portal
// vivo se hace al final, supervisada, no aquí.
// ─────────────────────────────────────────────────────────────────────────────
// Sólo lo que firmarReto usa de la FIEL. El objeto real es el `Credential` de
// @nodecfdi/credentials que ya carga getFielForCompany; reducirlo a esta
// interfaz desacopla la firma de esa librería y deja probar el armado del sobre
// con un doble, sin re-probar el RSA de nodecfdi (que es su código, ya probado).
export interface FirmanteFiel {
  sign(data: string, algorithm?: string): string;
  rfc(): string;
  certificate(): {
    pemAsOneLine(): string;
    serialNumber(): { decimal(): string };
    /** Vigencia final en ASN.1 UTCTime "YYMMDDHHMMSSZ" — es el campo `fert`. */
    validTo(): string;
  };
}

/**
 * El reto extraído del `certform` del SAT. La forma exacta se fijó con una
 * captura real (docs/sat-portal-captura.md, HAR de recon-sat-portal): el
 * formulario sirve un `guid` de sesión y unos campos del applet que se reenvían;
 * el cliente calcula `token` y `fert`.
 */
export interface RetoLogin {
  /** GUID de sesión que sirve el certform (hidden name="guid"). Va en el reto firmado. */
  guid: string;
  /** URL del applet del certform (hidden name="urlApplet"). Se reenvía tal cual. */
  urlApplet: string;
  /** Credencial requerida (hidden name="credentialsRequired", normalmente "CERT"). */
  credentialsRequired: string;
  /** Campo `ks` del certform (normalmente "null"). Se reenvía tal cual. */
  ks: string;
  /** URL a la que se postea el certform (sin action → la propia URL del formulario). */
  actionUrl: string;
}

/** El sobre listo para postear: el `token` calculado y el `fert` (vigencia). */
export interface SobreFirmado {
  /**
   * token = base64( base64(reto) + "#" + base64(base64(firma)) ),
   * reto = "guid|RFC|serie", firma = RSA-SHA1(reto). Verificado contra la captura.
   */
  token: string;
  /** Vigencia final del cert en "YYMMDDHHMMSSZ" (campo `fert`). */
  fert: string;
}

/**
 * Extrae el reto del `certform`. Se busca por NOMBRE y se falla ruidosamente si
 * falta el guid — sin él no hay reto que firmar, y un reto vacío da un 200 que
 * miente. El certform no trae `action`: se postea a su propia URL.
 */
export function extraerReto(html: string, urlBase: string): RetoLogin {
  const guid = valorDeInput(html, "guid");
  if (!guid) {
    throw new SatPortalAuthError(
      "No se encontró el guid en el certform del SAT. El portal pudo cambiar su formulario.",
    );
  }
  return {
    guid,
    urlApplet: valorDeInput(html, "urlApplet") ?? "",
    credentialsRequired: valorDeInput(html, "credentialsRequired") ?? "CERT",
    ks: valorDeInput(html, "ks") ?? "null",
    actionUrl: urlBase,
  };
}

/**
 * Firma el reto y arma el `token` del certform. El reto es "guid|RFC|serie"; se
 * firma con RSA-SHA1 (VERIFICADO contra la firma real capturada del portal — ver
 * scripts/sat-login-verify.ts) y se empaqueta en el doble-base64 del applet:
 *   token = base64( base64(reto) + "#" + base64( base64(firma) ) )
 * El cert NO se manda: el SAT lo busca por el RFC/serie que van en el reto.
 */
export function firmarReto(reto: RetoLogin, credential: FirmanteFiel): SobreFirmado {
  const cert = credential.certificate();
  const desafio = `${reto.guid}|${credential.rfc()}|${cert.serialNumber().decimal()}`;
  const firmaB64 = Buffer.from(credential.sign(desafio, "sha1"), "binary").toString("base64");
  const parteReto = Buffer.from(desafio, "utf8").toString("base64");
  const parteFirma = Buffer.from(firmaB64, "utf8").toString("base64"); // doble base64
  const token = Buffer.from(`${parteReto}#${parteFirma}`, "utf8").toString("base64");
  return { token, fert: cert.validTo() };
}

/**
 * Cuerpo `application/x-www-form-urlencoded` del POST del certform. Los nombres
 * replican el formulario real (ver docs/sat-portal-captura.md). El cert NO va —el
 * SAT lo busca por el RFC/serie que van dentro del token.
 */
export function cuerpoDeLogin(reto: RetoLogin, sobre: SobreFirmado): string {
  const p = new URLSearchParams();
  p.set("token", sobre.token);
  p.set("credentialsRequired", reto.credentialsRequired);
  p.set("guid", reto.guid);
  p.set("ks", reto.ks);
  p.set("seeder", "");
  p.set("arc", "");
  p.set("tan", "");
  p.set("placer", "");
  p.set("secuence", "");
  p.set("urlApplet", reto.urlApplet);
  p.set("jcaptcha", "");
  p.set("fert", sobre.fert);
  return p.toString();
}

/**
 * Lee la cookie de sesión de las cabeceras `set-cookie` de la respuesta de
 * login. Devuelve el header `Cookie` completo para las peticiones siguientes,
 * o null si el SAT no entregó sesión (login rechazado).
 */
export function extraerCookieSesion(setCookie: string[] | null): string | null {
  if (!setCookie || setCookie.length === 0) return null;
  const pares = setCookie
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("="));
  return pares.length > 0 ? pares.join("; ") : null;
}

export class SatPortalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SatPortalAuthError";
  }
}

// ── Helpers de HTML: mínimos y sin dependencias, por nombre no por posición ──

function valorDeInput(html: string, name: string): string | null {
  // <input ... name="tokenValue" ... value="XXX"> en cualquier orden de atributos.
  const re = new RegExp(
    `<input[^>]*\\bname=["']${escapar(name)}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? null;
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
