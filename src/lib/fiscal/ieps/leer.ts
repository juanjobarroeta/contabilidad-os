// Lectura de los renglones de IEPS de un periodo. Lo único que toca Prisma:
// toda la aritmética y todas las salvedades viven en `periodo.ts`, que es puro.

import type { PrismaClient } from "@prisma/client";
import type { RenglonIeps } from "./periodo";

/**
 * Los renglones de IEPS de los CFDIs del mes.
 *
 * DOS CUIDADOS QUE NO SON OBVIOS:
 *
 * 1. `status: { not: "CANCELLED" }` — una factura cancelada no causa impuesto.
 *    Es el mismo filtro que usan IVA e ISR, y por eso una factura marcada
 *    CANCELLED por error desaparece de los tres a la vez (ver #916).
 *
 * 2. `factor` manda sobre `tasa`. En un renglón CUOTA la columna `tasa` guarda
 *    el importe POR UNIDAD (p. ej. 1.6451 por litro de bebida saborizada), no
 *    una tasa: leerlo como tasa daría «164.51 %». Aquí sólo los renglones TASA
 *    traen tasa; los demás viajan con null y se agrupan como cuota.
 */
export async function leerRenglonesIeps(
  prisma: PrismaClient,
  companyId: string,
  year: number,
  month: number,
): Promise<RenglonIeps[]> {
  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  const filas = await prisma.invoiceTax.findMany({
    where: {
      tipo: "IEPS",
      invoice: {
        companyId,
        status: { not: "CANCELLED" },
        fecha: { gte: desde, lt: hasta },
        // Los dos sentidos con efecto: ingreso (lo cobra) y egreso (se lo
        // cobran). Nómina, traslado y pago no causan IEPS.
        tipo: { in: ["INGRESO", "EGRESO"] },
      },
    },
    select: {
      importe: true,
      tasa: true,
      factor: true,
      retencion: true,
      invoice: { select: { tipo: true } },
    },
  });

  return filas.map((f) => ({
    importe: Number(f.importe),
    tasa: f.factor === "TASA" ? Number(f.tasa) : null,
    retencion: f.retencion,
    sentido: f.invoice.tipo === "INGRESO" ? ("INGRESO" as const) : ("EGRESO" as const),
  }));
}
