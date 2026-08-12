// ─────────────────────────────────────────────────────────────────────────────
// Ingresos que no son unidad, ni mano de obra, ni refacción.
//
// Una distribuidora factura cosas que no caben en las tres líneas obvias, y en
// Margom no son marginales: ~$97M en la familia 8014xx del catálogo del SAT
// («actividades de promoción y desarrollo de negocios»). Sin esta clasificación
// ese dinero no aparecía en NINGUNA línea del estado de resultados.
//
// Dos conceptos distintos que la clave del SAT NO distingue — ambos viven bajo
// 80141600/80141601:
//
//   • BONOS del distribuidor (flotillas, incremental por volumen): se ganan
//     vendiendo unidades.
//   • UDI que pagan las aseguradoras —GNP, Quálitas, INBURSA—: pese al nombre
//     «uso de instalaciones», es la CONTRAPRESTACIÓN POR COLOCAR PÓLIZAS, o
//     sea comisión de F&I. No la produce el taller.
//
// Los dos son ingreso del FRONT END y NINGUNO entra en la absorción. El nombre
// del UDI es una trampa: suena a que la aseguradora paga por ocupar
// hojalatería, y meterlo en la absorción diría que el taller se paga solo
// cuando en realidad lo pagó la venta de seguros — justo la lectura que la
// absorción existe para evitar. Si algún día aparece un ingreso que SÍ produzca
// el taller, ése sí va en la absorción; éstos no.
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
 * UDI: lo que paga la aseguradora por las pólizas colocadas. «UDI» como palabra
 * suelta — no dentro de otra («cuidado», «estudio» no cuentan).
 */
const RE_UDI = /\budis?\b|uso\s+de\s+instalaci/i;

export type BucketIngreso = "bonos" | "uso_instalaciones" | "otros";

export interface OtroIngreso {
  clave: BucketIngreso;
  nombre: string;
  importe: number;
  conceptos: number;
}

export interface OtrosIngresosResultado {
  lineas: OtroIngreso[];
  total: number;
}

export function clasificarIngreso(descripcion: string | null | undefined): BucketIngreso {
  const d = descripcion ?? "";
  // El orden importa: el UDI es el concepto más específico y se nombra primero.
  if (RE_UDI.test(d)) return "uso_instalaciones";
  if (RE_BONO.test(d)) return "bonos";
  return "otros";
}

const NOMBRES: Record<BucketIngreso, string> = {
  bonos: "Bonos y apoyos del distribuidor",
  uso_instalaciones: "Comisiones de seguros (UDI)",
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
    const linea = acc.get(clave) ?? { clave, nombre: NOMBRES[clave], importe: 0, conceptos: 0 };
    linea.importe = r2(linea.importe + signo * f.importe);
    linea.conceptos++;
    acc.set(clave, linea);
  }

  const lineas = [...acc.values()].sort((a, b) => b.importe - a.importe);
  return { lineas, total: r2(lineas.reduce((s, l) => s + l.importe, 0)) };
}
