// ─────────────────────────────────────────────────────────────────────────────
// Tláloc (api.tlaloc.sh) — consulta a RENAPO por CURP o por datos.
//
//   GET https://api.tlaloc.sh/mx/v1/curp?curp=…
//   GET https://api.tlaloc.sh/mx/v1/curp?names=&first_last_name=&second_last_name=
//        &date_of_birth=YYYY-MM-DD&gender=H|M|X&state_of_birth=PL
//   Authorization: Bearer ${TLALOC_API_KEY}
//
// Respuesta (campos tal cual): nacionalidad, docProbatorio, statusCurp,
// nombres, parametro, primerApellido, segundoApellido, curp, fechaNacimiento
// «dd/mm/yyyy», sexo «HOMBRE»|«MUJER», datosDocProbatorio{…}, claveEntidad,
// entidad. Errores 400/404/422/500/503 con { error, message, details }.
// ─────────────────────────────────────────────────────────────────────────────

import { ENTIDADES_CURP } from "../curp";
import { entidadCurpDe } from "../identidad";
import { fetchConTimeout, TIMEOUT_RENAPO_MS, type FetchLike, type ProveedorRenapo } from "./base";
import { DOC_PROBATORIO, RenapoError, esEstatusActivo, fechaDdMmYyyyAIso, sexoRenapoDe, type BusquedaRenapo, type CurpRecord } from "./tipos";

export const TLALOC_URL = "https://api.tlaloc.sh/mx/v1/curp";

export interface TlalocCurpPayload {
  nacionalidad?: string | null;
  docProbatorio?: number | string | null;
  statusCurp?: string | null;
  nombres?: string | null;
  parametro?: string | null;
  primerApellido?: string | null;
  segundoApellido?: string | null;
  curp?: string | null;
  fechaNacimiento?: string | null;
  sexo?: string | null;
  datosDocProbatorio?: Record<string, unknown> | null;
  claveEntidad?: string | null;
  entidad?: string | null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Un registro de Tláloc → CurpRecord (vocabulario RENAPO). */
export function normalizarTlaloc(p: TlalocCurpPayload, referencia: string | null = null, consultadoEn: Date = new Date()): CurpRecord {
  const curp = texto(p.curp)?.toUpperCase();
  if (!curp) throw new RenapoError("UPSTREAM_UNAVAILABLE", "Tláloc contestó sin CURP");
  const fechaNacimiento = fechaDdMmYyyyAIso(p.fechaNacimiento) ?? curpAFechaIso(curp);
  const sexo = sexoRenapoDe(p.sexo) ?? (curp[10] === "H" ? "H" : curp[10] === "M" ? "M" : "X");
  const entidadClave = entidadCurpDe(texto(p.claveEntidad)) ?? entidadCurpDe(texto(p.entidad)) ?? curp.slice(11, 13);
  const estatus = (texto(p.statusCurp) ?? "").toUpperCase();
  const docProbatorio = p.docProbatorio == null || p.docProbatorio === "" ? null : String(p.docProbatorio);
  return {
    curp,
    nombres: texto(p.nombres) ?? "",
    primerApellido: texto(p.primerApellido) ?? "",
    segundoApellido: texto(p.segundoApellido),
    sexo,
    fechaNacimiento,
    entidadClave,
    entidadNombre: texto(p.entidad) ?? ENTIDADES_CURP[entidadClave] ?? null,
    nacionalidad: texto(p.nacionalidad),
    estatusCurp: estatus,
    activa: esEstatusActivo(estatus),
    docProbatorio,
    docProbatorioDescripcion: docProbatorio ? (DOC_PROBATORIO[docProbatorio] ?? null) : null,
    datosDocProbatorio: p.datosDocProbatorio && typeof p.datosDocProbatorio === "object" ? p.datosDocProbatorio : null,
    proveedor: "tlaloc",
    referencia,
    consultadoEn: consultadoEn.toISOString(),
  };
}

function curpAFechaIso(curp: string): string {
  const aa = Number(curp.slice(4, 6));
  const siglo = /[A-Z]/.test(curp[16] ?? "") ? 2000 : 1900;
  return `${siglo + aa}-${curp.slice(6, 8)}-${curp.slice(8, 10)}`;
}

/** Código HTTP + cuerpo { error, message } → RenapoError. Nunca incluye la credencial. */
export function errorTlaloc(status: number, body: unknown): RenapoError {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
  const mensaje = [texto(b.error), texto(b.message)].filter(Boolean).join(": ") || null;
  const detalle = mensaje ? `Tláloc (${status}): ${mensaje}` : undefined;
  if (status === 401 || status === 403) return new RenapoError("PROVIDER_AUTH", undefined, status);
  if (status === 404) return new RenapoError("NOT_FOUND", undefined, status);
  if (status === 429) return new RenapoError("RATE_LIMITED", undefined, status);
  if (status === 400) return new RenapoError("INVALID_FORMAT", detalle, status);
  if (status === 422) {
    return /multiple|m[uú]ltiple|varios|homonim/i.test(mensaje ?? "") ? new RenapoError("MULTIPLE_MATCHES", undefined, status) : new RenapoError("INVALID_FORMAT", detalle, status);
  }
  return new RenapoError("UPSTREAM_UNAVAILABLE", detalle, status);
}

export function proveedorTlaloc(apiKey: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): ProveedorRenapo {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_RENAPO_MS;

  async function llamar(params: Record<string, string>): Promise<{ body: unknown; referencia: string | null }> {
    const url = `${TLALOC_URL}?${new URLSearchParams(params).toString()}`;
    const res = await fetchConTimeout(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }, timeoutMs, fetchImpl);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorTlaloc(res.status, body);
    return { body, referencia: res.headers.get("x-request-id") ?? res.headers.get("x-tlaloc-request-id") };
  }

  return {
    nombre: "tlaloc",
    async consultarPorCurp(curp) {
      const { body, referencia } = await llamar({ curp: curp.trim().toUpperCase() });
      const registro = desempacar(body)[0];
      if (!registro) throw new RenapoError("NOT_FOUND");
      return normalizarTlaloc(registro, referencia);
    },
    async buscarPorDatos(q) {
      const params: Record<string, string> = {
        names: q.nombres.trim(),
        first_last_name: q.primerApellido.trim(),
        date_of_birth: q.fechaNacimiento,
        gender: q.sexo,
        state_of_birth: q.entidadClave,
      };
      // Tláloc EXIGE el segundo apellido: sin él —o vacío— contesta 422
      // «Provide either 'curp' or all of…», que aquí se traducía a «formato
      // inválido» y dejaba sin buscar a quien sólo tiene un apellido. La
      // convención de RENAPO para ese hueco es X, la misma que ya usan
      // `letrasCurp` y `letrasRfc`. Verificado contra la API: sin el
      // parámetro 422, con X la consulta entra y contesta 404 si no existe.
      params.second_last_name = q.segundoApellido?.trim() || "X";
      const { body, referencia } = await llamar(params);
      return desempacar(body).map((r) => normalizarTlaloc(r, referencia));
    },
  };
}

/** Tláloc contesta un objeto o una lista (búsqueda por datos); también { data: … } / { results: … }. */
function desempacar(body: unknown): TlalocCurpPayload[] {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object") as TlalocCurpPayload[];
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  for (const k of ["data", "results", "registros"]) {
    if (Array.isArray(b[k])) return (b[k] as unknown[]).filter((x) => x && typeof x === "object") as TlalocCurpPayload[];
    if (b[k] && typeof b[k] === "object") return [b[k] as TlalocCurpPayload];
  }
  return "curp" in b ? [b as TlalocCurpPayload] : [];
}

export type { BusquedaRenapo };
