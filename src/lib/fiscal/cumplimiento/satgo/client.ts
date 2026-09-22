// ─────────────────────────────────────────────────────────────────────────────
// SatGoClient — lo que usamos de la API de SatGo (api.sat-go.com).
//
// Autenticación con SatGo: SATGO_API_KEY puede traer la llave durable (se
// canjea por un JWT en POST /api/Auth/token-json) o directamente un JWT (se usa
// como Bearer, si no venció). Detectarlo evita el «Invalid key» que da canjear
// un JWT: es lo que pasó con la llave de preprod.
//
// Autenticación con el SAT: los endpoints v2 `*fiel` reciben la e.firma por
// multipart (Certificado + llavePrivada + Contrasena) — sin CIEC ni captcha —
// y devuelven el documento tal cual lo emite el SAT: PDF (CSF, 32-D) o ZIP de
// acuses PDF (declaraciones). La opinión IMSS va con sólo el RFC (GET). Todos
// tardan: el SAT/IMSS responden en 30–120 s, no SatGo.
// ─────────────────────────────────────────────────────────────────────────────

import type { FielSatGo } from "./fiel";

export class SatGoError extends Error {
  constructor(message: string, readonly status: number, readonly transitorio = false) {
    super(message);
    this.name = "SatGoError";
  }
}

export interface SatGoConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Tiempo máximo por llamada al SAT (ms). Default 4 min. */
  timeoutMs?: number;
}

/** Documento binario devuelto por SatGo. */
export interface DocumentoSatGo {
  data: Buffer;
  /** «application/pdf» | «application/zip» | … (sin parámetros). */
  contentType: string;
  /** Nombre que SatGo mandó en Content-Disposition, si lo mandó. */
  filename?: string;
  ms: number;
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

function filenameDe(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) { try { return decodeURIComponent(utf8[1].trim()); } catch { /* cae al plano */ } }
  const plano = disposition.match(/filename="?([^";]+)"?/i);
  return plano ? plano[1].trim() : undefined;
}

export interface ParamsDecFiel {
  ejercicio: number;
  /** 1–12, o 0 = todo el ejercicio (ZIP con un acuse por mes). */
  mes: number;
  /** «acuse» (default) | «declaracion» | «pago». */
  tipoDocumento?: "acuse" | "declaracion" | "pago";
}

export class SatGoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: string | null = null;

  constructor(cfg: SatGoConfig = {}) {
    this.apiKey = (cfg.apiKey ?? process.env.SATGO_API_KEY ?? "").trim();
    this.baseUrl = (cfg.baseUrl ?? process.env.SATGO_BASE ?? "https://api.sat-go.com").replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 240_000;
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
   * Llamada a un endpoint v2 que devuelve un documento. Con `fiel` es POST
   * multipart con la e.firma; sin ella es GET con sólo el header Rfc. Una
   * respuesta de texto (JSON/HTML) en vez de binario es error: el mensaje del
   * SAT/IMSS viaja en el SatGoError, marcado transitorio si huele a caída.
   */
  private async documento(
    path: string,
    rfc: string,
    opts: { query?: Record<string, string>; fiel?: FielSatGo; etiqueta: string },
  ): Promise<DocumentoSatGo> {
    const token = await this.bearer();
    const q = new URLSearchParams({ "api-version": "2.0", ...(opts.query ?? {}) });
    let body: FormData | undefined;
    if (opts.fiel) {
      body = new FormData();
      body.append("Certificado", new Blob([new Uint8Array(opts.fiel.cer)]), "e.cer");
      body.append("llavePrivada", new Blob([new Uint8Array(opts.fiel.key)]), "e.key");
      body.append("Contrasena", opts.fiel.pass);
    }
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}?${q}`, {
        method: opts.fiel ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, Rfc: rfc.trim().toUpperCase() },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SatGoError(`SatGo ${opts.etiqueta}: sin respuesta (${msg})`, 504, true);
    }
    const ms = Date.now() - t0;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    const esTexto = /json|text|html/.test(contentType) || buf.length < 1000;
    if (!res.ok || esTexto || !/pdf|zip|octet/.test(contentType)) {
      const muestra = buf.toString("utf8").slice(0, 240).replace(/\s+/g, " ");
      const transitorio = res.status >= 500 || /no disponible|reintent|intente m[aá]s tarde|timeout|temporalmente/i.test(muestra);
      throw new SatGoError(
        transitorio
          ? `${opts.etiqueta}: el SAT/IMSS no respondió (${muestra || res.status}); vuelve a intentar en unos minutos.`
          : `SatGo ${opts.etiqueta} ${res.status}: ${muestra || "respuesta vacía"}`,
        res.status || 502,
        transitorio,
      );
    }
    return { data: buf, contentType: contentType || "application/octet-stream", filename: filenameDe(res.headers.get("content-disposition")), ms };
  }

  /**
   * Opinión de cumplimiento IMSS (OCOFSS) en PDF, con sólo el RFC.
   * Cuando el IMSS está caído responde texto («servicio no disponible,
   * reintente»): se lanza SatGoError transitorio, no se inventa resultado.
   */
  async consultarImssOc(rfc: string): Promise<{ pdf: Buffer; contentType: string; ms: number }> {
    const d = await this.documento("/api/v2/consultar/imssoc", rfc, { etiqueta: "imssoc" });
    return { pdf: d.data, contentType: d.contentType, ms: d.ms };
  }

  /** Constancia de Situación Fiscal (PDF) con la e.firma. */
  async consultarCsfFiel(fiel: FielSatGo): Promise<DocumentoSatGo> {
    return this.documento("/api/v2/consultar/csffiel", fiel.rfc, { fiel, etiqueta: "csffiel" });
  }

  /** Opinión de cumplimiento del SAT (32-D CFF) en PDF, con la e.firma. */
  async consultarOcFiel(fiel: FielSatGo): Promise<DocumentoSatGo> {
    return this.documento("/api/v2/consultar/ocfiel", fiel.rfc, { fiel, etiqueta: "ocfiel" });
  }

  /**
   * Acuses de declaraciones presentadas (Declaraciones y Pagos) con la e.firma.
   * Un mes → normalmente un PDF (o ZIP si hay normal + complementarias);
   * mes = 0 → ZIP con «Normal_2025_Enero.pdf» … por cada mes presentado.
   */
  async consultarDecFiel(fiel: FielSatGo, p: ParamsDecFiel): Promise<DocumentoSatGo> {
    return this.documento("/api/v2/consultar/decfiel", fiel.rfc, {
      fiel,
      etiqueta: `decfiel ${p.ejercicio}-${p.mes}`,
      query: { ejercicio: String(p.ejercicio), mes: String(p.mes), tipoDocumento: p.tipoDocumento ?? "acuse" },
    });
  }
}
