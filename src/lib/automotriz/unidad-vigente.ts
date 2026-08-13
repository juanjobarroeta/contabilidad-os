import type { Prisma, PrismaClient } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// «¿Cuál es la unidad de este VIN?» — con ciclos de vida, la respuesta ya no es
// única.
//
// Una unidad física puede pasar por el piso varias veces: se compra nueva, se
// vende, el cliente la regresa años después, se recompra usada y se vuelve a
// vender. Cada pasada es un renglón de inventario distinto (Vehiculo.ciclo),
// con su propio costo y su propia venta.
//
// Casi todo el sistema —taller, pedidos, servicio, alta manual— pregunta por
// «la unidad de este VIN» queriendo decir LA VIGENTE: la del ciclo más alto.
// Este helper existe para que esa decisión se tome en un solo lugar y no en
// ocho `findUnique` sueltos que antes dependían del unique (companyId, vin).
// ─────────────────────────────────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * La unidad VIGENTE de un VIN: la del ciclo más alto. `null` si el VIN no
 * existe en la empresa.
 *
 * `select` se pasa tal cual a Prisma; sin él devuelve la fila completa.
 */
export async function unidadVigentePorVin<S extends Prisma.VehiculoSelect>(
  db: Db,
  companyId: string,
  vin: string,
  select?: S,
): Promise<Prisma.VehiculoGetPayload<{ select: S }> | null> {
  return db.vehiculo.findFirst({
    where: { companyId, vin },
    orderBy: { ciclo: "desc" },
    ...(select ? { select } : {}),
  }) as Promise<Prisma.VehiculoGetPayload<{ select: S }> | null>;
}

/**
 * Número del SIGUIENTE ciclo para un VIN (1 si nunca ha estado en la agencia).
 * Se usa al registrar una recompra: la unidad vieja se conserva intacta con su
 * historia y la nueva entra como ciclo+1.
 */
export async function siguienteCiclo(db: Db, companyId: string, vin: string): Promise<number> {
  const ultima = await db.vehiculo.findFirst({
    where: { companyId, vin },
    orderBy: { ciclo: "desc" },
    select: { ciclo: true },
  });
  return (ultima?.ciclo ?? 0) + 1;
}
