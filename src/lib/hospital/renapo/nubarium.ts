// ─────────────────────────────────────────────────────────────────────────────
// Nubarium — consulta a RENAPO por CURP o por datos.
//
//   POST https://api.nubarium.com/renapo/v3/valida_curp   { curp }
//   POST https://api.nubarium.com/renapo/obtener_curp     { nombre, primerApellido, segundoApellido,
//                                                           fechaNacimiento «dd/mm/yyyy», entidad «TS», sexo «M»|«H»|«X» }
//   Authorization: Basic base64(NUBARIUM_USUARIO:NUBARIUM_PASSWORD)
//
// Respuesta: estatus «OK», codigoValidacion, curp, nombre, apellidoPaterno,
// apellidoMaterno, sexo «HOMBRE», fechaNacimiento «dd/mm/yyyy», paisNacimiento,
// estadoNacimiento (nombre), docProbatorio, datosDocProbatorio, estatusCurp,
// codigoMensaje «0». Límite agotado: { codigoMensaje: "-1", estatus: "ERROR" }.
// ─────────────────────────────────────────────────────────────────────────────

import { ENTIDADES_CURP } from "../curp";
import { entidadCurpDe } from "../identidad";
import { fetchConTimeout, TIMEOUT_RENAPO_MS, type FetchLike, type ProveedorRenapo } from "./base";
import { DOC_PROBATORIO, RenapoError, esEstatusActivo, fechaDdMmYyyyAIso, isoAFechaDdMmYyyy, sexoRenapoDe, type CurpRecord } from "./tipos";

export const NUBARIUM_URL_VALIDAR = "https://api.nubarium.com/renapo/v3/valida_curp";
export const NUBARIUM_URL_OBTENER = "https://api.nubarium.com/renapo/obtener_curp";

export interface NubariumCurpPayload {
  estatus?: string | null;
  codigoValidacion?: string | null;
  codigoMensaje?: string | number | null;
  mensaje?: string | null;
  curp?: string | null;
  nombre?: string | null;
  apellidoPaterno?: string | null;
  apellidoMaterno?: string | null;
  sexo?: string | null;
  fechaNacimiento?: string | null;
  paisNacimiento?: string | null;
  estadoNacimiento?: string | null;
  docProbatorio?: number | string | null;
  datosDocProbatorio?: Record<string, unknown> | null;
  estatusCurp?: string | null;
  nacionalidad?: string | null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Un registro de Nubarium → CurpRecord (vocabulario RENAPO). */
export function normalizarNubarium(p: NubariumCurpPayload, consultadoEn: Date = new Date()): CurpRecord {
  const curp = texto(p.curp)?.toUpperCase();
  if (!curp) throw new RenapoError("UPSTREAM_UNAVAILABLE", "Nubarium contestó sin CURP");
  const fechaNacimiento = fechaDdMmYyyyAIso(p.fechaNacimiento) ?? curpAFechaIso(curp);
  const sexo = sexoRenapoDe(p.sexo) ?? (curp[10] === "H" ? "H" : curp[10] === "M" ? "M" : "X");
  const entidadClave = entidadCurpDe(texto(p.estadoNacimiento)) ?? curp.slice(11, 13);
  const estatus = (texto(p.estatusCurp) ?? "").toUpperCase();
  const docProbatorio = p.docProbatorio == null || p.docProbatorio === "" ? null : String(p.docProbatorio);
  const pais = texto(p.paisNacimiento);
  return {
    curp,
    nombres: texto(p.nombre) ?? "",
    primerApellido: texto(p.apellidoPaterno) ?? "",
    segundoApellido: texto(p.apellidoMaterno),
    sexo,
    fechaNacimiento,
    entidadClave,
    entidadNombre: texto(p.estadoNacimiento) ?? ENTIDADES_CURP[entidadClave] ?? null,
    nacionalidad: texto(p.nacionalidad) ?? (pais ? (/M[EÉ]XICO/i.test(pais) ? "MEX" : pais) : null),
    estatusCurp: estatus,
    activa: esEstatusActivo(estatus),
    docProbatorio,
    docProbatorioDescripcion: docProbatorio ? (DOC_PROBATORIO[docProbatorio] ?? null) : null,
    datosDocProbatorio: p.datosDocProbatorio && typeof p.datosDocProbatorio === "object" ? p.datosDocProbatorio : null,
    proveedor: "nubarium",
    referencia: texto(p.codigoValidacion),
    consultadoEn: consultadoEn.toISOString(),
  };
}

function curpAFechaIso(curp: string): string {
  const aa = Number(curp.slice(4, 6));
  const siglo = /[A-Z]/.test(curp[16] ?? "") ? 2000 : 1900;
  return `${siglo + aa}-${curp.slice(6, 8)}-${curp.slice(8, 10)}`;
}

/** Errores HTTP y cuerpos { estatus: "ERROR", codigoMensaje, mensaje } → RenapoError. */
export function errorNubarium(status: number, body: unknown): RenapoError {
  const b = (body ?? {}) as NubariumCurpPayload;
  const mensaje = texto(b.mensaje);
  if (status === 401 || status === 403) return new RenapoError("PROVIDER_AUTH", undefined, status);
  if (status === 429) return new RenapoError("RATE_LIMITED", undefined, status);
  if (status >= 500) return new RenapoError("UPSTREAM_UNAVAILABLE", mensaje ? `Nubarium (${status}): ${mensaje}` : undefined, status);
  if (String(b.codigoMensaje ?? "") === "-1") return new RenapoError("RATE_LIMITED", undefined, status);
  if (mensaje && /no (se )?encontr|no existe|sin resultados|no registrad/i.test(mensaje)) return new RenapoError("NOT_FOUND", undefined, status);
  if (mensaje && /m[uú]ltiple|varios|homonim/i.test(mensaje)) return new RenapoError("MULTIPLE_MATCHES", undefined, status);
  if (status === 400 || (mensaje && /formato|inv[aá]lid/i.test(mensaje))) return new RenapoError("INVALID_FORMAT", mensaje ? `Nubarium: ${mensaje}` : undefined, status);
  return new RenapoError("UPSTREAM_UNAVAILABLE", mensaje ? `Nubarium (${status}): ${mensaje}` : undefined, status);
}

export function proveedorNubarium(usuario: string, password: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): ProveedorRenapo {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_RENAPO_MS;
  const autorizacion = `Basic ${Buffer.from(`${usuario}:${password}`, "utf8").toString("base64")}`;

  async function llamar(url: string, cuerpo: Record<string, string>): Promise<unknown> {
    const res = await fetchConTimeout(
      url,
      { method: "POST", headers: { Authorization: autorizacion, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(cuerpo) },
      timeoutMs,
      fetchImpl
    );
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorNubarium(res.status, body);
    const b = (body ?? {}) as NubariumCurpPayload;
    if ((b.estatus ?? "").toUpperCase() === "ERROR" || String(b.codigoMensaje ?? "0") === "-1") throw errorNubarium(res.status, body);
    return body;
  }

  return {
    nombre: "nubarium",
    async consultarPorCurp(curp) {
      const body = await llamar(NUBARIUM_URL_VALIDAR, { curp: curp.trim().toUpperCase() });
      const registro = desempacar(body)[0];
      if (!registro) throw new RenapoError("NOT_FOUND");
      return normalizarNubarium(registro);
    },
    async buscarPorDatos(q) {
      const body = await llamar(NUBARIUM_URL_OBTENER, {
        nombre: q.nombres.trim(),
        primerApellido: q.primerApellido.trim(),
        segundoApellido: q.segundoApellido?.trim() ?? "",
        fechaNacimiento: isoAFechaDdMmYyyy(q.fechaNacimiento),
        entidad: q.entidadClave,
        sexo: q.sexo,
      });
      return desempacar(body).map((r) => normalizarNubarium(r));
    },
  };
}

function desempacar(body: unknown): NubariumCurpPayload[] {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object") as NubariumCurpPayload[];
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  for (const k of ["resultados", "registros", "data", "curps"]) {
    if (Array.isArray(b[k])) return (b[k] as unknown[]).filter((x) => x && typeof x === "object") as NubariumCurpPayload[];
  }
  return texto(b.curp) ? [b as NubariumCurpPayload] : [];
}
