/**
 * IEPS del período, DERIVADO DE LOS CFDIs.
 *
 * Esto NO es una posición fiscal: es la suma de lo que los comprobantes ya
 * dicen. La distinción importa y por eso está en el nombre de todo lo que
 * devuelve esta función.
 *
 * POR QUÉ EXISTE. `computeTaxPosition` calcula IVA e ISR y no toca IEPS — el
 * motor «llega después», dice el comentario de `TaxDeclaration.iepsPagar`. Para
 * un distribuidor de abarrote gourmet eso no es un detalle: el chocolate, las
 * galletas y los untables con más de 275 kcal/100 g causan IEPS del 8 %
 * (alimentos no básicos de alta densidad calórica), y en el caso que motivó
 * esto son ~$305 mil al año repartidos en 380 renglones. Enseñar «Total al SAT»
 * sin decir que ese impuesto existe es peor que no enseñar nada.
 *
 * LO QUE ESTA FUNCIÓN NO HACE, A PROPÓSITO:
 *
 * 1. NO acredita. El acreditamiento del IEPS está limitado por inciso (Art. 4
 *    LIEPS) y no todo revendedor puede restar el que pagó. La diferencia entre
 *    poder y no poder son decenas de miles de pesos al año, así que aquí se
 *    devuelven los dos lados por separado y `neto` va etiquetado como
 *    aritmética, no como saldo a pagar. Quien decide es el contador.
 *
 * 2. NO usa flujo. El IVA se determina cuando se cobra (Art. 1-B LIVA) y el
 *    motor del hub lo hace así; esto suma por FECHA DE CFDI, que es más simple
 *    y basta para saber de qué tamaño es el asunto. Se marca `baseFecha` para
 *    que nadie confunda esta cifra con una declaración.
 */

import type { PrismaClient } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;

export type IepsPorTasa = {
  tasa: number;
  trasladado: number;
  pagado: number;
  renglones: number;
};

export type IepsDerivado = {
  /** Siempre true: recordatorio de que esto sale de comprobantes, no de un motor. */
  derivado: true;
  /** Cómo se asignó al período. "CFDI" = por fecha del comprobante, no por flujo. */
  baseFecha: "CFDI";
  /** IEPS que ella cobró (CFDIs de INGRESO). */
  trasladado: number;
  /** IEPS que le cobraron (CFDIs de EGRESO). */
  pagado: number;
  /** trasladado − pagado. ARITMÉTICA, no un saldo a enterar: falta la regla
   *  de acreditamiento del Art. 4 LIEPS. */
  neto: number;
  renglones: number;
  porTasa: IepsPorTasa[];
  /** true si hay algo que enseñar; evita pintar una tarjeta vacía. */
  hay: boolean;
};

export async function iepsDelPeriodo(
  prisma: PrismaClient,
  companyId: string,
  year: number,
  month: number
): Promise<IepsDerivado> {
  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  const renglones = await prisma.invoiceTax.findMany({
    where: {
      tipo: "IEPS",
      invoice: {
        companyId,
        status: { not: "CANCELLED" },
        fecha: { gte: desde, lt: hasta },
        // Sólo los dos sentidos que tienen efecto: ingreso (lo cobra) y egreso
        // (se lo cobran). Nómina y traslado no causan IEPS.
        tipo: { in: ["INGRESO", "EGRESO"] },
      },
    },
    select: {
      importe: true,
      tasa: true,
      retencion: true,
      invoice: { select: { tipo: true } },
    },
  });

  const porTasa = new Map<number, IepsPorTasa>();
  let trasladado = 0;
  let pagado = 0;

  for (const r of renglones) {
    // Una retención de IEPS no es el impuesto del período: se entera aparte y
    // sumarla aquí inflaría los dos lados.
    if (r.retencion) continue;

    const importe = Number(r.importe);
    const tasa = Number(r.tasa ?? 0);
    const fila = porTasa.get(tasa) ?? { tasa, trasladado: 0, pagado: 0, renglones: 0 };

    if (r.invoice.tipo === "INGRESO") {
      trasladado += importe;
      fila.trasladado += importe;
    } else {
      pagado += importe;
      fila.pagado += importe;
    }
    fila.renglones++;
    porTasa.set(tasa, fila);
  }

  const filas = [...porTasa.values()]
    .map((f) => ({
      ...f,
      trasladado: r2(f.trasladado),
      pagado: r2(f.pagado),
    }))
    .sort((a, b) => b.tasa - a.tasa);

  return {
    derivado: true,
    baseFecha: "CFDI",
    trasladado: r2(trasladado),
    pagado: r2(pagado),
    neto: r2(trasladado - pagado),
    renglones: filas.reduce((a, f) => a + f.renglones, 0),
    porTasa: filas,
    hay: filas.length > 0,
  };
}
