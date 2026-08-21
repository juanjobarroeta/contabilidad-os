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
  };
}

/** El reto extraído de la página de login del SAT. */
export interface RetoLogin {
  /** El valor que hay que firmar (el `tokenValue` del formulario). */
  token: string;
  /** URL a la que se postea el sobre firmado (action del formulario). */
  actionUrl: string;
}

/** El sobre firmado, listo para postear como formulario. */
export interface SobreFirmado {
  token: string;
  /** Firma del token en base64. */
  firmaBase64: string;
  /** Certificado en una sola línea base64 (sin cabeceras PEM). */
  certificadoBase64: string;
  /** Número de serie del certificado, en decimal (como lo espera el SAT). */
  numeroSerie: string;
  /** RFC del titular — se manda como pista y sirve para validar la respuesta. */
  rfc: string;
}

/**
 * Extrae el reto de la página de login. El portal cambia el marcado sin avisar,
 * así que se buscan los campos por NOMBRE (name="tokenValue") y no por posición,
 * y se falla ruidosamente si no aparecen — un reto vacío firmado da un 200 que
 * miente, que es exactamente lo que hay que evitar.
 */
export function extraerReto(html: string, urlBase: string): RetoLogin {
  const token = valorDeInput(html, "tokenValue") ?? valorDeInput(html, "token");
  if (!token) {
    throw new SatPortalAuthError(
      "No se encontró el reto (tokenValue) en la página de login del SAT. " +
        "El portal pudo haber cambiado su formulario.",
    );
  }
  const action = atributoDeForm(html, "action");
  const actionUrl = action ? resolverUrl(action, urlBase) : urlBase;
  return { token, actionUrl };
}

/**
 * Firma el reto con la FIEL y arma el sobre. `Credential` es el mismo objeto
 * que ya carga getFielForCompany — aquí sólo se usa su `sign()` y su
 * certificado, así que esta función es pura respecto a la red.
 *
 * El SAT firma con SHA-1 sobre el token (mismo algoritmo del sello de la
 * descarga masiva). Se deja parametrizable por si un endpoint pide SHA-256, sin
 * cambiar el resto.
 */
export function firmarReto(
  reto: RetoLogin,
  credential: FirmanteFiel,
  algoritmo: "sha1" | "sha256" = "sha1",
): SobreFirmado {
  const firmaBinaria = credential.sign(reto.token, algoritmo);
  const cert = credential.certificate();
  return {
    token: reto.token,
    firmaBase64: Buffer.from(firmaBinaria, "binary").toString("base64"),
    certificadoBase64: cert.pemAsOneLine(),
    numeroSerie: cert.serialNumber().decimal(),
    rfc: credential.rfc(),
  };
}

/**
 * El cuerpo `application/x-www-form-urlencoded` del POST de login. Los nombres
 * de campo replican los del formulario del SAT; se centralizan aquí para que un
 * cambio del portal se arregle en un solo lugar.
 */
export function cuerpoDeLogin(sobre: SobreFirmado): string {
  const p = new URLSearchParams();
  p.set("tokenValue", sobre.token);
  p.set("guid", sobre.token);
  p.set("firma", sobre.firmaBase64);
  p.set("certificado", sobre.certificadoBase64);
  p.set("numeroSerie", sobre.numeroSerie);
  p.set("rfc", sobre.rfc);
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

function atributoDeForm(html: string, attr: string): string | null {
  const tag = html.match(/<form[^>]*>/i)?.[0];
  if (!tag) return null;
  const re = new RegExp(`\\b${escapar(attr)}=["']([^"']*)["']`, "i");
  return tag.match(re)?.[1] ?? null;
}

function resolverUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
