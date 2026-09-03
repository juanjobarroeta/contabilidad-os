// ─────────────────────────────────────────────────────────────────────────────
// ISR retenido a médicos: lo que el hospital retuvo (10 %, Art. 106 LISR) en
// los CFDIs de honorarios que le expidieron PERSONAS FÍSICAS en el periodo.
//
// retencionesDelPeriodo (motor del hub) ya suma «ISR retenido a personas
// físicas» pero no distingue por RFC: mete todo EGRESO con retención de ISR.
// Aquí se acota a contrapartes con RFC de 13 posiciones — persona física — que
// en un hospital son, casi sin excepción, los médicos tratantes. Una nota de
// crédito (tipoSat "E") resta, igual que en el motor.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface IsrRetenidoMedicos {
  monto: number;
  comprobantes: number;
}

export async function isrRetenidoMedicosDelPeriodo(
  db: Db,
  companyId: string,
  year: number,
  month: number
): Promise<IsrRetenidoMedicos> {
  const desde = new Date(year, month - 1, 1);
  const hasta = new Date(year, month, 1);
  const filas = await db.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: { not: "CANCELLED" },
      fecha: { gte: desde, lt: hasta },
      taxes: { some: { tipo: "ISR", retencion: true } },
    },
    select: {
      tipoSat: true,
      contraparteRfc: true,
      customer: { select: { rfc: true } },
      taxes: { where: { tipo: "ISR", retencion: true }, select: { importe: true } },
    },
  });
  let monto = 0;
  let comprobantes = 0;
  for (const f of filas) {
    const rfc = (f.contraparteRfc ?? f.customer?.rfc ?? "").trim();
    if (rfc.length !== 13) continue;
    const signo = f.tipoSat === "E" ? -1 : 1;
    monto += signo * f.taxes.reduce((s, t) => s + Number(t.importe), 0);
    comprobantes++;
  }
  return { monto: r2(monto), comprobantes };
}
