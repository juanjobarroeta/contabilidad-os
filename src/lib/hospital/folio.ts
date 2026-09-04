// ─────────────────────────────────────────────────────────────────────────────
// Folios del módulo: HOSP-2026-0418, COT-2026-0311, MANT-2026-0007.
//
// Prefijo por empresa (HospConfig) con defaults, año local y consecutivo de
// cuatro dígitos que reinicia cada año. El consecutivo es «filas de ese año
// + 1», pero nunca por debajo del mayor ya emitido: un seed o una migración
// que meta folios altos no provoca choques ni retrocesos.
//
// Concurrencia: dentro de una transacción se toma un candado consultivo por
// (empresa, serie) — pg_advisory_xact_lock — así dos ingresos simultáneos
// no calculan el mismo número. Fuera de transacción el candado se suelta al
// instante y queda la red de seguridad del @@unique([companyId, folio]):
// `conFolioUnico` reintenta una vez si aun así chocó.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";
import { partesLocales } from "./tz";

type Db = PrismaClient | Prisma.TransactionClient;

export type SerieFolio = "episodio" | "cotizacion" | "ticket";

export const PREFIJO_DEFAULT: Record<SerieFolio, string> = {
  episodio: "HOSP",
  cotizacion: "COT",
  ticket: "MANT",
};

export function formatearFolio(prefijo: string, anio: number, n: number): string {
  return `${prefijo}-${anio}-${String(n).padStart(4, "0")}`;
}

/** Consecutivo de un folio de la serie/año dados; null si no es de esa forma. */
export function consecutivoDeFolio(folio: string, prefijo: string, anio: number): number | null {
  const m = new RegExp(`^${prefijo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${anio}-(\\d+)$`).exec(folio);
  return m ? Number(m[1]) : null;
}

/** Siguiente consecutivo dada la lista de folios ya emitidos de la serie/año. */
export function siguienteConsecutivo(folios: string[], prefijo: string, anio: number): number {
  let mayor = 0;
  let cuenta = 0;
  for (const f of folios) {
    const n = consecutivoDeFolio(f, prefijo, anio);
    if (n == null) continue;
    cuenta++;
    if (n > mayor) mayor = n;
  }
  return Math.max(cuenta + 1, mayor + 1);
}

export async function prefijoDeSerie(db: Db, companyId: string, serie: SerieFolio): Promise<string> {
  const cfg = await db.hospConfig.findUnique({
    where: { companyId },
    select: { serieEpisodio: true, serieCotizacion: true, serieTicket: true },
  });
  if (!cfg) return PREFIJO_DEFAULT[serie];
  const p = serie === "episodio" ? cfg.serieEpisodio : serie === "cotizacion" ? cfg.serieCotizacion : cfg.serieTicket;
  return p?.trim() || PREFIJO_DEFAULT[serie];
}

export async function siguienteFolio(
  db: Db,
  companyId: string,
  serie: SerieFolio,
  fecha: Date = new Date()
): Promise<string> {
  // Serializa a los que compiten por la misma serie dentro de una transacción.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hosp-folio:${companyId}:${serie}`}))`;

  const prefijo = await prefijoDeSerie(db, companyId, serie);
  const anio = partesLocales(fecha).y;
  const where = { companyId, folio: { startsWith: `${prefijo}-${anio}-` } };
  const select = { folio: true } as const;
  const filas =
    serie === "episodio"
      ? await db.hospEpisodio.findMany({ where, select })
      : serie === "cotizacion"
        ? await db.hospCotizacion.findMany({ where, select })
        : await db.hospTicket.findMany({ where, select });
  return formatearFolio(prefijo, anio, siguienteConsecutivo(filas.map((f) => f.folio), prefijo, anio));
}

/** True si el error es el choque del @@unique([companyId, folio]). */
export function esChoqueDeFolio(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    JSON.stringify(e.meta?.target ?? "").includes("folio")
  );
}

/**
 * Corre `crear` (que debe abrir SU transacción, pedir el folio con
 * `siguienteFolio(tx, …)` y escribir) y, si chocó el folio, lo reintenta una
 * vez. El reintento tiene que ser de la transacción completa: Postgres aborta
 * la transacción entera tras una violación de unicidad.
 */
export async function conFolioUnico<T>(crear: () => Promise<T>): Promise<T> {
  try {
    return await crear();
  } catch (e) {
    if (!esChoqueDeFolio(e)) throw e;
    return await crear();
  }
}
