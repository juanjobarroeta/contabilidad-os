// ─────────────────────────────────────────────────────────────────────────────
// Vocabulario de RENAPO (Anexo Técnico wsCurp 2022) al que se normaliza lo que
// contesta cualquier proveedor (Tláloc, Nubarium…). Sin red ni Prisma.
// ─────────────────────────────────────────────────────────────────────────────

export type EstatusCurp = "AN" | "AH" | "RCC" | "RCN" | "BD" | "BSU" | "BAP" | "BDM" | "BDP" | "BJD";

/** Estatus oficial de la CURP: las cuatro primeras son claves ACTIVAS; las «B…» son bajas. */
export const ESTATUS_CURP: Record<string, { descripcion: string; activa: boolean }> = {
  AN: { descripcion: "Alta normal", activa: true },
  AH: { descripcion: "Alta con homonimia", activa: true },
  RCC: { descripcion: "Registro de cambio afectando a la CURP", activa: true },
  RCN: { descripcion: "Registro de cambio no afectando a la CURP", activa: true },
  BD: { descripcion: "Baja por defunción", activa: false },
  BSU: { descripcion: "Baja sin uso", activa: false },
  BAP: { descripcion: "Baja por documento apócrifo", activa: false },
  BDM: { descripcion: "Baja administrativa", activa: false },
  BDP: { descripcion: "Baja por adopción", activa: false },
  BJD: { descripcion: "Baja judicial", activa: false },
};

export function esEstatusActivo(estatus: string | null | undefined): boolean {
  const e = (estatus ?? "").trim().toUpperCase();
  return !!ESTATUS_CURP[e]?.activa;
}

export function descripcionEstatus(estatus: string | null | undefined): string {
  const e = (estatus ?? "").trim().toUpperCase();
  return ESTATUS_CURP[e]?.descripcion ?? (e ? `Estatus ${e}` : "Sin estatus");
}

/** Documento probatorio con el que se registró la CURP (catálogo RENAPO). */
export const DOC_PROBATORIO: Record<string, string> = {
  "1": "Acta de nacimiento",
  "2": "Carta de naturalización",
  "3": "Documento migratorio",
  "4": "Certificado de nacionalidad mexicana",
  "5": "Carta de naturalización (Ley)",
  "6": "Acta de nacimiento extranjera",
};

export type SexoRenapo = "H" | "M" | "X";
export type ProveedorRenapoNombre = "tlaloc" | "nubarium";

/** Un registro de RENAPO normalizado, como lo guardan las rutas y lo enseña el satélite. */
export interface CurpRecord {
  curp: string;
  nombres: string;
  primerApellido: string;
  segundoApellido: string | null;
  sexo: SexoRenapo;
  /** «AAAA-MM-DD». */
  fechaNacimiento: string;
  /** Clave RENAPO de dos letras (AS…ZS, NE). */
  entidadClave: string;
  entidadNombre: string | null;
  nacionalidad: string | null;
  estatusCurp: string;
  activa: boolean;
  docProbatorio: string | null;
  docProbatorioDescripcion: string | null;
  datosDocProbatorio: Record<string, unknown> | null;
  proveedor: ProveedorRenapoNombre;
  /** Identificador de la consulta en el proveedor (para la bitácora), nunca la credencial. */
  referencia: string | null;
  /** ISO 8601. */
  consultadoEn: string;
}

export interface BusquedaRenapo {
  nombres: string;
  primerApellido: string;
  segundoApellido?: string | null;
  /** «AAAA-MM-DD». */
  fechaNacimiento: string;
  sexo: SexoRenapo;
  /** Clave RENAPO de dos letras. */
  entidadClave: string;
}

export type RenapoErrorCodigo = "NOT_FOUND" | "INVALID_FORMAT" | "MULTIPLE_MATCHES" | "UPSTREAM_UNAVAILABLE" | "RATE_LIMITED" | "PROVIDER_AUTH";

export const MENSAJE_RENAPO: Record<RenapoErrorCodigo, string> = {
  NOT_FOUND: "RENAPO no tiene registrada esa CURP o esos datos",
  INVALID_FORMAT: "El proveedor rechazó la consulta: datos con formato inválido",
  MULTIPLE_MATCHES: "RENAPO encontró más de una persona con esos datos",
  UPSTREAM_UNAVAILABLE: "RENAPO no está disponible en este momento; intenta más tarde",
  RATE_LIMITED: "Se alcanzó el límite de consultas a RENAPO del proveedor",
  PROVIDER_AUTH: "El proveedor de RENAPO rechazó las credenciales del hub",
};

export class RenapoError extends Error {
  constructor(
    public codigo: RenapoErrorCodigo,
    message?: string,
    public status?: number
  ) {
    super(message || MENSAJE_RENAPO[codigo]);
    this.name = "RenapoError";
  }
}

/** «26/06/1956» → «1956-06-26»; también acepta ya-ISO. null si no es fecha. */
export function fechaDdMmYyyyAIso(s: string | null | undefined): string | null {
  const v = (s ?? "").trim();
  let y: number, m: number, d: number;
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (match) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** «1956-06-26» → «26/06/1956» (lo que piden los proveedores). */
export function isoAFechaDdMmYyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** «HOMBRE», «MUJER», «H», «M», «X» (y variantes) → H | M | X. */
export function sexoRenapoDe(s: string | null | undefined): SexoRenapo | null {
  const v = (s ?? "").trim().toUpperCase();
  if (v === "H" || v === "HOMBRE" || v === "MASCULINO") return "H";
  if (v === "M" || v === "MUJER" || v === "FEMENINO") return "M";
  if (v === "X" || v === "NO BINARIO") return "X";
  return null;
}

/** Lo que el satélite enseña de un registro (sin los datos del documento probatorio). */
export function datosRenapo(r: CurpRecord) {
  return {
    curp: r.curp,
    nombres: r.nombres,
    primerApellido: r.primerApellido,
    segundoApellido: r.segundoApellido,
    sexo: r.sexo,
    fechaNacimiento: r.fechaNacimiento,
    entidadClave: r.entidadClave,
    entidadNombre: r.entidadNombre,
    nacionalidad: r.nacionalidad,
    docProbatorio: r.docProbatorio,
    docProbatorioDescripcion: r.docProbatorioDescripcion,
    estatus: r.estatusCurp,
    estatusDescripcion: descripcionEstatus(r.estatusCurp),
    activa: r.activa,
  };
}
