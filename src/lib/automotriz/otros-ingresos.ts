// ─────────────────────────────────────────────────────────────────────────────
// Ingresos que no son unidad, ni mano de obra, ni refacción.
//
// Una distribuidora factura cosas que no caben en las tres líneas obvias, y en
// Margom no son marginales: ~$97M en la familia 8014xx del catálogo del SAT
// («actividades de promoción y desarrollo de negocios»). Sin esta clasificación
// ese dinero no aparecía en NINGUNA línea del estado de resultados.
//
// Dos hallazgos que obligan a separarlos, y que la clave del SAT NO distingue —
// las dos viven bajo 80141600/80141601:
//
//   • BONOS del distribuidor (flotillas, incremental por volumen): ingreso del
//     FRONT END. Se gana por vender unidades, no por operar el taller, así que
//     va arriba de la absorción: contarlo como back end inflaría la absorción
//     con dinero que no produce el taller.
//   • USO DE INSTALACIONES (UDI) que pagan las aseguradoras —GNP, Quálitas,
//     INBURSA— por meter sus siniestros a hojalatería y pintura: ingreso del
//     BACK END. Lo produce la capacidad del taller, así que SÍ entra en la
//     absorción.
//
// Se clasifica por DESCRIPCIÓN, no por clave, porque la clave mezcla las dos —
// y lo que no empata cae en «Otros ingresos» a la vista, en vez de repartirse
// a ojo entre las dos anteriores. Un renglón honesto de sobras vale más que una
// precisión inventada.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Bonos y apoyos del distribuidor: se ganan vendiendo unidades. */
const RE_BONO = /\bbono|apoyo|incentiv/i;
/**
 * Uso de instalaciones: lo que paga la aseguradora por ocupar el taller de
 * hojalatería. «UDI» como palabra suelta — no dentro de otra (p. ej. «UDIS» de
 * indexación financiera sí empata, pero en este contexto es el mismo concepto).
 */
const RE_UDI = /\budis?\b|uso\s+de\s+instalaci/i;

export type BucketIngreso = "bonos" | "uso_instalaciones" | "otros";

export interface OtroIngreso {
  clave: BucketIngreso;
  nombre: string;
  /** true = lo produce el taller; cuenta para la absorción. */
  backEnd: boolean;
  importe: number;
  conceptos: number;
}

export interface OtrosIngresosResultado {
  lineas: OtroIngreso[];
  total: number;
  /** Parte que sí es back end (uso de instalaciones): entra a la absorción. */
  backEnd: number;
}

export function clasificarIngreso(descripcion: string | null | undefined): BucketIngreso {
  const d = descripcion ?? "";
  // El orden importa: «BONO por uso de instalaciones» sería un bono, pero en la
  // práctica el UDI es el concepto más específico y se nombra primero.
  if (RE_UDI.test(d)) return "uso_instalaciones";
  if (RE_BONO.test(d)) return "bonos";
  return "otros";
}

const NOMBRES: Record<BucketIngreso, string> = {
  bonos: "Bonos y apoyos del distribuidor",
  uso_instalaciones: "Uso de instalaciones (aseguradoras)",
  otros: "Otros ingresos",
};

/**
 * Suma por concepto los ingresos 8014xx del periodo, EXCLUYENDO los CFDIs que
 * ya amparan una unidad — bajo 80141615 se factura carrocería de lujo con
 * complemento vehicular, y ésa ya está contada como venta de unidad.
 */
export async function otrosIngresos(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<OtrosIngresosResultado> {
  const filas = await db.$queryRaw<Array<{ descripcion: string | null; importe: number; tipoSat: string | null }>>(
    Prisma.sql`
      SELECT ii."descripcion", ii."importe"::float8 AS importe, i."tipoSat"
      FROM "Invoice" i
      JOIN "InvoiceItem" ii ON ii."invoiceId" = i.id
      WHERE i."companyId" = ${companyId}
        AND i."tipo" = 'INGRESO'
        AND i."status" <> 'CANCELLED'
        AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
        AND ii."claveProdServ" LIKE '8014%'
        AND NOT EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."ventaInvoiceId" = i.id)
    `
  );

  const acc = new Map<BucketIngreso, OtroIngreso>();
  for (const f of filas) {
    const clave = clasificarIngreso(f.descripcion);
    // Nota de crédito emitida: resta del ingreso, igual que en el resto del motor.
    const signo = f.tipoSat === "E" ? -1 : 1;
    const linea =
      acc.get(clave) ??
      { clave, nombre: NOMBRES[clave], backEnd: clave === "uso_instalaciones", importe: 0, conceptos: 0 };
    linea.importe = r2(linea.importe + signo * f.importe);
    linea.conceptos++;
    acc.set(clave, linea);
  }

  const lineas = [...acc.values()].sort((a, b) => b.importe - a.importe);
  return {
    lineas,
    total: r2(lineas.reduce((s, l) => s + l.importe, 0)),
    backEnd: r2(lineas.filter((l) => l.backEnd).reduce((s, l) => s + l.importe, 0)),
  };
}
