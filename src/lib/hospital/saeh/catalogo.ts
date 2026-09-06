// ─────────────────────────────────────────────────────────────────────────────
// SAEH — acceso a los catálogos maestros (HospCatalogo) detrás de una
// interfaz chica, para que prellenar/validar corran igual contra Postgres
// (memoizado: una hoja repite país, entidad, servicios…) o contra un catálogo
// en memoria en las pruebas.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type HospCatalogoTipo, type PrismaClient } from "@prisma/client";
import { buscarCie, type FilaCie } from "../cie";
import { claveComparable } from "./texto";

type Db = PrismaClient | Prisma.TransactionClient;

export interface FilaCatalogo {
  tipo: HospCatalogoTipo;
  clave: string;
  codigo: string;
  nombre: string;
  padre: string | null;
  activo: boolean;
  datos: Record<string, unknown> | null;
}

export interface CatalogoSaeh {
  /** Fila por (tipo, clave) exacta; null si no existe. No filtra `activo`. */
  fila(tipo: HospCatalogoTipo, clave: string): Promise<FilaCatalogo | null>;
  /** Fila por nombre sin acentos ni mayúsculas («Puebla» → 21), acotada al padre si se da. */
  porNombre(tipo: HospCatalogoTipo, nombre: string, padre?: string | null): Promise<FilaCatalogo | null>;
  /** CIE-10 / CIE-9-MC por código clínico o clave DGIS (ver cie.ts). */
  cie(tipo: "CIE10" | "CIE9MC", codigo: string): Promise<FilaCie | null>;
  /** Todo el catálogo SERVICIOS_ESPECIALIDADES activo. */
  servicios(): Promise<FilaCatalogo[]>;
}

const selectFila = { tipo: true, clave: true, codigo: true, nombre: true, padre: true, activo: true, datos: true } as const;

type FilaDb = { tipo: HospCatalogoTipo; clave: string; codigo: string; nombre: string; padre: string | null; activo: boolean; datos: unknown };

function aFila(f: FilaDb): FilaCatalogo {
  return {
    tipo: f.tipo,
    clave: f.clave,
    codigo: f.codigo,
    nombre: f.nombre,
    padre: f.padre,
    activo: f.activo,
    datos: f.datos && typeof f.datos === "object" && !Array.isArray(f.datos) ? (f.datos as Record<string, unknown>) : null,
  };
}

/** Sin acentos ni eñe, como translate() en SQL, para comparar nombres. */
const comparable = (s: string) => claveComparable(s).replace(/Ñ/g, "N");

/** Catálogo contra Postgres con memoria por instancia (una por petición o por exportación). */
export function catalogoPrisma(db: Db): CatalogoSaeh {
  const filas = new Map<string, Promise<FilaCatalogo | null>>();
  const nombres = new Map<string, Promise<FilaCatalogo | null>>();
  const cies = new Map<string, Promise<FilaCie | null>>();
  let servicios: Promise<FilaCatalogo[]> | null = null;

  return {
    fila(tipo, clave) {
      const k = `${tipo}:${clave}`;
      let p = filas.get(k);
      if (!p) {
        p = db.hospCatalogo.findUnique({ where: { tipo_clave: { tipo, clave } }, select: selectFila }).then((f) => (f ? aFila(f) : null));
        filas.set(k, p);
      }
      return p;
    },
    porNombre(tipo, nombre, padre) {
      const n = comparable(nombre);
      if (!n) return Promise.resolve(null);
      const k = `${tipo}:${padre ?? ""}:${n}`;
      let p = nombres.get(k);
      if (!p) {
        p = db
          .$queryRaw<FilaDb[]>`
            SELECT tipo, clave, codigo, nombre, padre, activo, datos
            FROM "HospCatalogo"
            WHERE tipo = ${tipo}::"HospCatalogoTipo"
              AND translate(upper(nombre), 'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛ', 'AEIOUUNAEIOUAEIOU') = ${n}
              ${padre ? Prisma.sql`AND padre = ${padre}` : Prisma.empty}
            ORDER BY activo DESC, clave ASC
            LIMIT 1`
          .then((rs) => (rs[0] ? aFila(rs[0]) : null));
        nombres.set(k, p);
      }
      return p;
    },
    cie(tipo, codigo) {
      const k = `${tipo}:${codigo.trim().toUpperCase()}`;
      let p = cies.get(k);
      if (!p) {
        p = buscarCie(db, tipo, codigo);
        cies.set(k, p);
      }
      return p;
    },
    servicios() {
      if (!servicios) {
        servicios = db.hospCatalogo.findMany({ where: { tipo: "SERVICIO", activo: true }, select: selectFila, orderBy: { clave: "asc" } }).then((fs) => fs.map(aFila));
      }
      return servicios;
    },
  };
}

/** Catálogo en memoria para pruebas y scripts. */
export function catalogoEnMemoria(filas: FilaCatalogo[], cie: FilaCie[] = []): CatalogoSaeh {
  return {
    async fila(tipo, clave) {
      return filas.find((f) => f.tipo === tipo && f.clave === clave) ?? null;
    },
    async porNombre(tipo, nombre, padre) {
      const n = comparable(nombre);
      return filas.find((f) => f.tipo === tipo && comparable(f.nombre) === n && (!padre || f.padre === padre)) ?? null;
    },
    async cie(tipo, codigo) {
      const c = codigo.trim().toUpperCase();
      const clave = c.replace(/\./g, "");
      return cie.find((f) => f.tipo === tipo && (f.codigo === c || f.clave === clave || f.codigo === `${c}.X` || f.clave === `${clave}X`)) ?? null;
    },
    async servicios() {
      return filas.filter((f) => f.tipo === "SERVICIO" && f.activo);
    },
  };
}

/** Atajo para armar filas de prueba. */
export function filaCatalogo(tipo: HospCatalogoTipo, clave: string, nombre: string, extra: Partial<FilaCatalogo> = {}): FilaCatalogo {
  return { tipo, clave, codigo: extra.codigo ?? clave, nombre, padre: extra.padre ?? null, activo: extra.activo ?? true, datos: extra.datos ?? null };
}

// ── Servicio (SERVICIOS_ESPECIALIDADES) a partir de la especialidad del médico ──

/** Variantes frecuentes en la ficha del médico que el catálogo escribe distinto. */
const ALIAS_SERVICIO: Readonly<Record<string, string>> = {
  ANESTESIOLOGIA: "501",
  ANESTESIA: "501",
  "ORTOPEDIA Y TRAUMATOLOGIA": "510",
  "TRAUMATOLOGIA Y ORTOPEDIA": "510",
  "GINECOLOGIA Y OBSTETRICIA": "403",
  "GINECO OBSTETRICIA": "403",
  GINECOOBSTETRICIA: "403",
  "MEDICINA CRITICA": "603",
  "TERAPIA INTENSIVA": "603",
  "CUIDADOS INTENSIVOS": "603",
  CIRUGIA: "201",
  "CIRUGIA GENERAL Y LAPAROSCOPICA": "201",
  "CIRUGIA LAPAROSCOPICA": "207",
  "CIRUGIA BARIATRICA": "202",
  "CIRUGIA PLASTICA Y RECONSTRUCTIVA": "211",
  "CIRUGIA CARDIOTORACICA": "203",
  "NEUROCIRUGIA": "213",
  COLOPROCTOLOGIA: "204",
  "MEDICINA FAMILIAR": "506",
  "MEDICINA GENERAL": "506",
  OTORRINOLARINGOLOGIA: "511",
  NEONATOLOGIA: "338",
  "TERAPIA INTENSIVA PEDIATRICA": "605",
  "PSIQUIATRIA INFANTIL": "319",
  PAIDOPSIQUIATRIA: "319",
  ONCOLOGIA: "116",
  "ONCOLOGIA MEDICA": "116",
  "ONCOLOGIA QUIRURGICA": "210",
  "CIRUGIA ONCOLOGICA": "210",
  "UROLOGIA": "214",
  "ORTOPEDIA": "510",
  "TRAUMATOLOGIA": "517",
  "REHABILITACION": "516",
  "MEDICINA FISICA Y REHABILITACION": "516",
  "MEDICINA INTERNA": "112",
  "GASTROENTEROLOGIA": "107",
  "ENDOSCOPIA": "207",
  "ENDOSCOPIA GASTROINTESTINAL": "107",
};

/**
 * Clave del servicio DGIS que corresponde a una especialidad escrita a mano
 * («Cirugía general» → 201). Alias primero, luego nombre exacto del catálogo,
 * luego el nombre de catálogo más largo contenido en el texto. Null si nada.
 */
export function servicioDeEspecialidad(especialidad: string | null | undefined, servicios: FilaCatalogo[]): string | null {
  if (!especialidad) return null;
  const e = comparable(especialidad);
  if (!e) return null;
  if (ALIAS_SERVICIO[e]) return ALIAS_SERVICIO[e];
  const exacto = servicios.find((s) => comparable(s.nombre) === e);
  if (exacto) return exacto.clave;
  let mejor: FilaCatalogo | null = null;
  for (const s of servicios) {
    const n = comparable(s.nombre);
    if (!n || n === "OTRA" || n === "NO ESPECIFICADO") continue;
    if ((` ${e} `).includes(` ${n} `) && (!mejor || n.length > comparable(mejor.nombre).length)) mejor = s;
  }
  return mejor?.clave ?? null;
}
