// ─────────────────────────────────────────────────────────────────────────────
// Folios del módulo: PED-2026-0412, OC-2026-0033, IMP-2026-0007.
//
// Mismo contrato que src/lib/hospital/folio.ts —prefijo por empresa con
// default, año LOCAL (America/Mexico_City) y consecutivo de cuatro dígitos que
// reinicia cada año— para que quien conozca un módulo conozca el otro.
//
// El año es local y no UTC porque un pedido de la tienda a las 19:00 del 31 de
// diciembre es del año que se está cerrando, no del siguiente: en UTC ya son
// las 01:00 del 1 de enero y el folio saltaría de año a media tarde.
//
// Concurrencia: candado consultivo por (empresa, serie) dentro de la
// transacción. La tienda es el caso real —dos personas pagando al mismo
// tiempo un viernes— y sin el candado los dos pedidos calculan el mismo
// número. Fuera de transacción queda la red del @@unique([companyId, folio])
// y `conFolioUnico`, que reintenta una vez.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";
import { partesLocales } from "../hospital/tz";

type Db = PrismaClient | Prisma.TransactionClient;

export type SerieSal = "pedido" | "compra" | "importacion";

export const PREFIJO_DEFAULT: Record<SerieSal, string> = {
  pedido: "PED",
  compra: "OC",
  importacion: "IMP",
};

export function formatearFolio(prefijo: string, anio: number, n: number): string {
  return `${prefijo}-${anio}-${String(n).padStart(4, "0")}`;
}

/** Consecutivo de un folio de la serie/año dados; null si no es de esa forma. */
export function consecutivoDeFolio(
  folio: string,
  prefijo: string,
  anio: number
): number | null {
  const m = new RegExp(
    `^${prefijo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${anio}-(\\d+)$`
  ).exec(folio);
  return m ? Number(m[1]) : null;
}

/**
 * Siguiente consecutivo dada la lista de folios ya emitidos de la serie/año.
 * Es «cuántos hay + 1», pero nunca por debajo del mayor emitido: un seed que
 * meta folios altos no provoca choques ni retrocesos.
 */
export function siguienteConsecutivo(
  folios: string[],
  prefijo: string,
  anio: number
): number {
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

export async function prefijoDeSerie(
  db: Db,
  companyId: string,
  serie: SerieSal
): Promise<string> {
  const cfg = await db.salConfig.findUnique({
    where: { companyId },
    select: { seriePedido: true, serieCompra: true, serieImportacion: true },
  });
  if (!cfg) return PREFIJO_DEFAULT[serie];
  const p =
    serie === "pedido"
      ? cfg.seriePedido
      : serie === "compra"
        ? cfg.serieCompra
        : cfg.serieImportacion;
  return p?.trim() || PREFIJO_DEFAULT[serie];
}

export async function siguienteFolio(
  db: Db,
  companyId: string,
  serie: SerieSal,
  fecha: Date = new Date()
): Promise<string> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sal-folio:${companyId}:${serie}`}))`;

  const prefijo = await prefijoDeSerie(db, companyId, serie);
  const anio = partesLocales(fecha).y;
  const where = { companyId, folio: { startsWith: `${prefijo}-${anio}-` } };
  const select = { folio: true } as const;

  const filas =
    serie === "pedido"
      ? await db.salPedido.findMany({ where, select })
      : serie === "compra"
        ? await db.salCompra.findMany({ where, select })
        : await db.salImportacion.findMany({ where, select });

  return formatearFolio(
    prefijo,
    anio,
    siguienteConsecutivo(
      filas.map((f) => f.folio),
      prefijo,
      anio
    )
  );
}

/** True si el error es el choque del @@unique([companyId, folio]). */
export function esChoqueDeFolio(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return false;
  }
  return JSON.stringify(e.meta?.target ?? "").includes("folio");
}

/**
 * Corre `crear` (que debe abrir SU transacción, pedir el folio con
 * `siguienteFolio(tx, …)` y escribir) y, si chocó el folio, lo reintenta una
 * vez. El reintento tiene que ser de la transacción COMPLETA: Postgres aborta
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

/**
 * El slug de la tienda a partir del nombre: «PRE ORDER Cubeta Crema Lotus
 * Creamy 8kg» → «pre-order-cubeta-crema-lotus-creamy-8kg». Es la URL pública,
 * así que se genera una vez y no se toca al renombrar (cambiarlo rompe los
 * enlaces que ya circulan por WhatsApp).
 */
export function slugify(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Un slug libre para la empresa: agrega -2, -3… si ya existe. */
export async function slugUnico(
  db: Db,
  companyId: string,
  base: string
): Promise<string> {
  const raiz = slugify(base) || "producto";
  const tomados = await db.salProducto.findMany({
    where: { companyId, slug: { startsWith: raiz } },
    select: { slug: true },
  });
  const set = new Set(tomados.map((p) => p.slug));
  if (!set.has(raiz)) return raiz;
  for (let i = 2; i < 1000; i++) {
    const cand = `${raiz}-${i}`;
    if (!set.has(cand)) return cand;
  }
  return `${raiz}-${Date.now()}`;
}
