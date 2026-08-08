// ─────────────────────────────────────────────────────────────────────────────
// Cliente Syntage (api.syntage.com). Mecánica confirmada en docs:
//   • Auth: header X-Api-Key.
//   • Credenciales: POST /credentials  {type:"ciec", rfc, password}
//                                      {type:"efirma", certificate, privateKey, password}
//   • Extracción async: POST /extractions {extractor, entity, options} → status
//     pending→running→finished/failed; GET /extractions/{id} para sondear.
//   • Extractores: tax_compliance (opinión), tax_status (CSF), annual_tax_return,
//     monthly_tax_return, invoice, tax_retention, electronic_accounting
//     (Contabilidad Electrónica: catálogo de cuentas / balanza / pólizas), …
// Las claves exactas del RESULTADO (positiva/negativa, campos de la CSF) se
// mapean en map.ts y están marcadas // VERIFY hasta cotejar una respuesta viva.
// ─────────────────────────────────────────────────────────────────────────────

export type Extractor =
  | "tax_compliance"
  | "tax_status"
  | "annual_tax_return"
  | "monthly_tax_return"
  | "invoice"
  | "tax_retention"
  | "electronic_accounting";

export type EstadoCredencial =
  | "waiting"
  | "pending"
  | "valid"
  | "invalid"
  | "disabled"
  | "deactivated"
  | "error";

export type EstadoExtraccion =
  | "pending"
  | "running"
  | "finished"
  | "failed"
  | "stopped"
  | "cancelled";

export interface SyntageConfig {
  apiKey?: string;
  baseUrl?: string;
}

export class SyntageError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = "SyntageError";
  }
}

type Json = Record<string, unknown>;

export class SyntageClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(cfg: SyntageConfig = {}) {
    this.apiKey = cfg.apiKey ?? process.env.SYNTAGE_API_KEY ?? "";
    this.baseUrl = (cfg.baseUrl ?? process.env.SYNTAGE_BASE_URL ?? "https://api.syntage.com").replace(/\/$/, "");
    if (!this.apiKey) throw new SyntageError("Falta SYNTAGE_API_KEY.");
  }

  private async request<T = Json>(method: string, path: string, body?: Json): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/ld+json, application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new SyntageError(`Syntage ${method} ${path} → ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  // ── Entidades ────────────────────────────────────────────────────────────────
  /**
   * Crea una entidad. `name` y `type` son obligatorios (type: "company" = PM,
   * "person" = PF); `rfc` es opcional pero recomendado.
   */
  async createEntity(args: {
    name: string;
    type: "company" | "person";
    rfc?: string;
    datasources?: Json[];
  }): Promise<{ id: string }> {
    const r = await this.request<Json>("POST", "/entities", args as Json);
    return { id: String(r.id ?? "") };
  }

  /**
   * Colección COMPLETA, paginando. API Platform limita cada página (~30 por
   * default); un GET pelado sólo trae la primera, así que todo lo que caiga
   * después es invisible: findEntityByRfc deja de encontrar entidades
   * existentes y ensureEntity crea duplicados. Itera hasta página corta.
   */
  private async requestAllPages(path: string, itemsPerPage = 200, maxPages = 50): Promise<Json[]> {
    const sep = path.includes("?") ? "&" : "?";
    const all: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request<Json>("GET", `${path}${sep}itemsPerPage=${itemsPerPage}&page=${page}`);
      const batch = asArray(r);
      all.push(...batch);
      if (batch.length < itemsPerPage) break;
    }
    return all;
  }

  async listEntities(): Promise<Json[]> {
    return this.requestAllPages("/entities");
  }

  /**
   * Busca una entidad existente por RFC (para no duplicar). Syntage expone el RFC
   * en distintos campos (rfc/taxpayer…), así que se busca el RFC en cualquier
   * parte del registro; el id se toma de `id` o del IRI `@id`.
   */
  async findEntityByRfc(rfc: string): Promise<{ id: string } | null> {
    const list = await this.listEntities();
    const target = rfc.trim().toUpperCase();
    const m = list.find((e) => JSON.stringify(e).toUpperCase().includes(target));
    if (!m) return null;
    const id = String(m.id ?? iriId(m["@id"]));
    return id ? { id } : null;
  }

  /** Crea la entidad o reutiliza la existente por RFC. Infiere el type por RFC. */
  async ensureEntity(args: { rfc: string; name: string }): Promise<{ id: string }> {
    const found = await this.findEntityByRfc(args.rfc);
    if (found) return found;
    const type = args.rfc.trim().length === 12 ? "company" : "person";
    return this.createEntity({ name: args.name, type, rfc: args.rfc });
  }

  // ── Credenciales ──────────────────────────────────────────────────────────────
  async createCiecCredential(rfc: string, password: string): Promise<{ id: string; status: EstadoCredencial }> {
    const r = await this.request<Json>("POST", "/credentials", { type: "ciec", rfc, password });
    return { id: String(r.id), status: r.status as EstadoCredencial };
  }

  async createEfirmaCredential(args: {
    certificate: string; // base64 .cer
    privateKey: string; // base64 .key
    password: string;
  }): Promise<{ id: string; status: EstadoCredencial }> {
    const r = await this.request<Json>("POST", "/credentials", { type: "efirma", ...args });
    return { id: String(r.id), status: r.status as EstadoCredencial };
  }

  async listCredentials(): Promise<Json[]> {
    return this.requestAllPages("/credentials");
  }

  /**
   * TODAS las credenciales de un RFC, en cualquier estado (valid/invalid/…).
   * Para liberar el slot de un RFC hay que borrarlas todas — una credencial
   * inválida sigue contando como RFC vinculado en el plan de Syntage.
   */
  async credencialesDeRfc(rfc: string): Promise<{ id: string; status: string }[]> {
    const list = await this.listCredentials();
    const target = rfc.trim().toUpperCase();
    return list
      .filter((c) => String(c.rfc ?? "").toUpperCase() === target)
      .map((c) => ({ id: String(c.id ?? iriId(c["@id"])), status: String(c.status ?? "") }))
      .filter((c) => c.id);
  }

  /**
   * Borra una credencial (libera el RFC vinculado del plan). DELETE devuelve
   * 204 sin cuerpo; un 404 se trata como ya-borrada (idempotente).
   */
  async deleteCredential(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/credentials/${id}`);
    } catch (e) {
      if (e instanceof SyntageError && e.status === 404) return;
      throw e;
    }
  }

  /** Borra una entidad (y su historial extraído en Syntage). 404 = ya borrada. */
  async deleteEntity(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/entities/${id}`);
    } catch (e) {
      if (e instanceof SyntageError && e.status === 404) return;
      throw e;
    }
  }

  /** Credencial VÁLIDA existente para un RFC, o null. */
  async findValidCredentialForRfc(rfc: string): Promise<{ id: string } | null> {
    const list = await this.listCredentials();
    const m = list.find(
      (c) => String(c.rfc ?? "").toUpperCase() === rfc.toUpperCase() && String(c.status) === "valid",
    );
    return m ? { id: String(m.id) } : null;
  }

  async getCredential(id: string): Promise<{ id: string; status: EstadoCredencial; raw: Json }> {
    const r = await this.request<Json>("GET", `/credentials/${id}`);
    return { id: String(r.id), status: r.status as EstadoCredencial, raw: r };
  }

  /** Sondea una credencial hasta que valida (o falla). */
  async waitForCredentialValid(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const t0 = Date.now();
    for (;;) {
      const { status, raw } = await this.getCredential(id);
      if (status === "valid") return;
      if (status === "invalid" || status === "error" || status === "disabled" || status === "deactivated") {
        throw new SyntageError(`Credencial ${id} en estado ${status}`, undefined, raw);
      }
      if (Date.now() - t0 > timeoutMs) throw new SyntageError(`Credencial ${id} no validó a tiempo`);
      await sleep(intervalMs);
    }
  }

  // ── Extracciones ──────────────────────────────────────────────────────────────
  async createExtraction(args: {
    extractor: Extractor;
    entity: string; // uuid o IRI; Syntage (JSON-LD) requiere IRI "/entities/{id}"
    options?: Json; // p.ej. { period: { from, to } }
  }): Promise<{ id: string; status: EstadoExtraccion }> {
    const entity = args.entity.startsWith("/") ? args.entity : `/entities/${args.entity}`;
    const body: Json = { extractor: args.extractor, entity };
    if (args.options) body.options = args.options;
    const r = await this.request<Json>("POST", "/extractions", body);
    return { id: String(r.id), status: r.status as EstadoExtraccion };
  }

  async getExtraction(id: string): Promise<{ id: string; status: EstadoExtraccion; raw: Json }> {
    const r = await this.request<Json>("GET", `/extractions/${id}`);
    return { id: String(r.id), status: r.status as EstadoExtraccion, raw: r };
  }

  /**
   * Descarga el PDF del acuse a partir de la referencia guardada (`acuseUrl`).
   * Robusto a ambos formatos: si es `/files/{id}` baja directo; si es el recurso
   * (`/tax-compliance-checks/{id}` o `/tax-status/{id}`) primero lo lee para
   * obtener `file.@id`. Devuelve los bytes para hacer stream desde un proxy
   * server-side (la API key nunca llega al browser).
   */
  async downloadAcuse(ref: string): Promise<{ data: ArrayBuffer; contentType: string; filename?: string }> {
    let fileId: string | null = null;
    if (ref.includes("/files/")) {
      fileId = ref.replace(/.*\/files\//, "").replace(/\/download$/, "") || null;
    } else {
      const path = ref.startsWith("/") ? ref : `/${ref}`;
      const r = await this.request<Json>("GET", path);
      const file = r.file as Json | undefined;
      const fid = file ? String(file["@id"] ?? file.id ?? "") : "";
      fileId = fid ? fid.replace(/.*\/files\//, "") || fid : null;
    }
    if (!fileId) throw new SyntageError(`No se pudo resolver el archivo de "${ref}"`);

    const res = await fetch(`${this.baseUrl}/files/${fileId}/download`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) throw new SyntageError(`Syntage download /files/${fileId} → ${res.status}`, res.status);

    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") ?? "application/pdf",
      filename: m ? decodeURIComponent(m[1]) : undefined,
    };
  }

  /** Último TaxComplianceCheck (opinión) de la entidad, o null. */
  async getLatestTaxComplianceCheck(entityId: string): Promise<Json | null> {
    const r = await this.request<Json>(
      "GET",
      `/entities/${entityId}/tax-compliance-checks?order%5BcreatedAt%5D=desc&itemsPerPage=1`,
    );
    return asArray(r)[0] ?? null;
  }

  /** Último TaxStatus (CSF) de la entidad, o null. */
  async getLatestTaxStatus(entityId: string): Promise<Json | null> {
    const r = await this.request<Json>(
      "GET",
      `/entities/${entityId}/tax-status?order%5BcreatedAt%5D=desc&itemsPerPage=1`,
    );
    return asArray(r)[0] ?? null;
  }

  /**
   * Declaraciones (tax-returns) ya extraídas de la entidad, más recientes primero.
   * Recurso unificado: `intervalUnit` ∈ "Anual" | "Mensual" | "RIF" distingue el
   * tipo. Endpoint y campos confirmados en docs.syntage.com (tax-returns).
   */
  async getEntityTaxReturns(entityId: string): Promise<Json[]> {
    const r = await this.request<Json>(
      "GET",
      `/entities/${entityId}/tax-returns?order%5BcreatedAt%5D=desc&itemsPerPage=200`,
    );
    return asArray(r);
  }

  /**
   * Registros de Contabilidad Electrónica (Anexo 24) ya extraídos de la entidad,
   * más recientes primero. Cada registro trae `year`/`month`, `fileType`
   * ("CT" = catálogo de cuentas, "B" = balanza, "PL" = pólizas) y un arreglo
   * `files` con los XML del SAT (mimeType text/xml). Endpoint y forma confirmados
   * en docs.syntage.com (electronic-accounting-records). El XML descargable es el
   * `catalogocuentas` / `BCE` que parsean parseCatalogoCuentas / parseBalanza.
   */
  async getEntityElectronicAccounting(entityId: string): Promise<Json[]> {
    const r = await this.request<Json>(
      "GET",
      `/entities/${entityId}/electronic-accounting-records?order%5BcreatedAt%5D=desc&itemsPerPage=200`,
    );
    return asArray(r);
  }

  /**
   * Descarga los bytes de un archivo de Syntage a partir de su referencia
   * (`/files/{id}`, `/files/{id}/download` o un IRI de recurso con `file`).
   * Reutiliza la mecánica de downloadAcuse pero sin asumir PDF: aquí el contenido
   * es el XML del SAT (text/xml). Devuelve el texto decodificado UTF-8.
   */
  async downloadFileText(ref: string): Promise<string> {
    const { data } = await this.downloadAcuse(ref);
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }

  /** Sondea una extracción hasta que termina o falla. */
  async waitForExtraction(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Json> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const t0 = Date.now();
    for (;;) {
      const { status, raw } = await this.getExtraction(id);
      if (status === "finished") return raw;
      if (status === "failed" || status === "stopped" || status === "cancelled") {
        throw new SyntageError(`Extracción ${id} terminó en estado ${status}`, undefined, raw);
      }
      if (Date.now() - t0 > timeoutMs) throw new SyntageError(`Extracción ${id} excedió el tiempo de espera`);
      await sleep(intervalMs);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function asArray(r: unknown): Json[] {
  if (Array.isArray(r)) return r as Json[];
  if (r && typeof r === "object") {
    const members = (r as Json)["hydra:member"] ?? (r as Json).member ?? (r as Json).data;
    if (Array.isArray(members)) return members as Json[];
  }
  return [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Último segmento de un IRI JSON-LD, p.ej. "/entities/abc" → "abc". */
function iriId(iri: unknown): string {
  return typeof iri === "string" ? (iri.split("/").pop() ?? "") : "";
}
