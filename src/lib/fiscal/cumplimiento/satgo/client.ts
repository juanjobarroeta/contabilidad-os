// ─────────────────────────────────────────────────────────────────────────────
// SatGoClient — lo mínimo de la API de SatGo que usamos para cumplimiento.
//
// Autenticación: la variable SATGO_API_KEY puede traer la llave durable (se
// canjea por un JWT en POST /api/Auth/token-json) o directamente un JWT (se usa
// como Bearer, si no venció). Detectarlo evita el «Invalid key» que da canjear
// un JWT: es lo que pasó con la llave de preprod. Sin SMTP, sin captcha, sin
// e.firma para el IMSS: la opinión OCOFSS se pide con sólo el RFC y tarda
// alrededor de un minuto y medio (el IMSS, no SatGo).
// ─────────────────────────────────────────────────────────────────────────────

export class SatGoError extends Error {
  constructor(message: string, readonly status: number, readonly transitorio = false) {
    super(message);
    this.name = "SatGoError";
  }
}

export interface SatGoConfig {
  apiKey?: string;
  baseUrl?: string;
}

/** ¿Está configurado SatGo en este entorno? (sin construir el cliente) */
export function satGoConfigurado(): boolean {
  return !!(process.env.SATGO_API_KEY ?? "").trim();
}

function inspeccionarJwt(v: string): { esJwt: boolean; vencido?: boolean } {
  const partes = v.split(".");
  if (partes.length !== 3 || !v.startsWith("eyJ")) return { esJwt: false };
  try {
    const payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")) as { exp?: number };
    return { esJwt: true, vencido: typeof payload.exp === "number" ? payload.exp * 1000 < Date.now() : undefined };
  } catch {
    return { esJwt: true };
  }
}

export class SatGoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private token: string | null = null;

  constructor(cfg: SatGoConfig = {}) {
    this.apiKey = (cfg.apiKey ?? process.env.SATGO_API_KEY ?? "").trim();
    this.baseUrl = (cfg.baseUrl ?? process.env.SATGO_BASE ?? "https://api.sat-go.com").replace(/\/$/, "");
    if (!this.apiKey) throw new SatGoError("SATGO_API_KEY no configurada", 503);
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const jwt = inspeccionarJwt(this.apiKey);
    if (jwt.esJwt) {
      if (jwt.vencido) throw new SatGoError("El token de SatGo venció; hay que poner la llave durable en SATGO_API_KEY", 503);
      this.token = this.apiKey;
      return this.token;
    }
    const res = await fetch(`${this.baseUrl}/api/Auth/token-json?api-version=1.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.apiKey }),
    });
    const txt = (await res.text()).trim();
    if (!res.ok) throw new SatGoError(`SatGo Auth/token-json ${res.status}: ${txt.slice(0, 160)}`, res.status);
    let token = txt.replace(/^"|"$/g, "");
    try {
      const j = JSON.parse(txt);
      token = j.tokens?.access?.value ?? j.token ?? j.jwt ?? j.access_token ?? token;
    } catch { /* texto plano */ }
    this.token = token;
    return token;
  }

  /**
   * Opinión de cumplimiento IMSS (OCOFSS) en PDF, con sólo el RFC.
   * Cuando el IMSS está caído responde texto («servicio no disponible,
   * reintente»): se lanza SatGoError transitorio, no se inventa resultado.
   */
  async consultarImssOc(rfc: string): Promise<{ pdf: Buffer; contentType: string; ms: number }> {
    const token = await this.bearer();
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/api/v2/consultar/imssoc?api-version=2.0`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Rfc: rfc.trim().toUpperCase() },
    });
    const ms = Date.now() - t0;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0];
    const buf = Buffer.from(await res.arrayBuffer());
    const esTexto = /json|text/.test(contentType) || buf.length < 2000;
    if (!res.ok || esTexto || !/pdf|octet/.test(contentType)) {
      const muestra = buf.toString("utf8").slice(0, 240).replace(/\s+/g, " ");
      const transitorio = res.status >= 500 || /no disponible|reintent|intente m[aá]s tarde|timeout/i.test(muestra);
      throw new SatGoError(
        transitorio ? `El IMSS no respondió (${muestra || res.status}); vuelve a intentar en unos minutos.` : `SatGo imssoc ${res.status}: ${muestra || "respuesta vacía"}`,
        res.status || 502,
        transitorio,
      );
    }
    return { pdf: buf, contentType: contentType || "application/pdf", ms };
  }
}
