// ─────────────────────────────────────────────────────────────────────────────
// RETENCIONES A ENTERAR: lo que la empresa debe al SAT como RETENEDOR.
//
// El IVA propio y el ISR provisional son impuestos de la empresa. Las
// retenciones no: son dinero de terceros que la empresa ya descontó y sólo
// custodia hasta el día 17. Se declaran en el mismo pago mensual, pero no
// salen de ningún cálculo de utilidad — salen de lo que se retuvo:
//
//   • ISR de sueldos y salarios (Art. 96 LISR) — de los recibos de nómina
//     EMITIDOS. En una agencia con cientos de empleados es, mes con mes, la
//     obligación más grande después del IVA, y no aparecía en ningún lado.
//   • ISR de asimilados a salarios (Art. 94, régimen 05–11) — mismo entero,
//     renglón distinto en la declaración.
//   • ISR retenido a proveedores (honorarios y arrendamiento de personas
//     físicas, 10% Art. 106/116).
//   • IVA retenido a proveedores (2/3 a personas físicas por honorarios y
//     arrendamiento, 4% a fletes — Art. 1-A LIVA y RLIVA 3).
//
// Y del otro lado, lo que a la empresa LE retuvieron sus clientes: no es un
// pasivo sino un anticipo, y ya viene acreditado dentro del IVA y del ISR
// provisional. Se reporta aparte para que nadie lo sume dos veces.
//
// Todo sale de los CFDIs sincronizados. Emitidos vs recibidos se distingue por
// la nota de procedencia que graba el sync del SAT ("SAT — emitidos").
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { REGIMENES_ASIMILADOS } from "@/lib/nomina/regimen";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface RetencionConcepto {
  clave: string;
  nombre: string;
  /** Fundamento, para que el número sea defendible sin abrir la ley. */
  fundamento: string;
  monto: number;
  /** CFDIs que lo sostienen. */
  comprobantes: number;
}

export interface RetencionesPeriodo {
  periodo: string;
  /** Lo que se entera al SAT el día 17: dinero de terceros ya descontado. */
  aEnterar: number;
  conceptos: RetencionConcepto[];
  /**
   * Lo que los CLIENTES le retuvieron a la empresa. NO es un pasivo: se
   * acredita contra el IVA y el ISR del propio periodo (y ya está aplicado en
   * esos cálculos). Se expone sólo para explicar el neto.
   */
  aFavor: { iva: number; isr: number };
  /** Recibos de nómina emitidos en el periodo, para dimensionar el entero. */
  recibosNomina: number;
}

/** Rango del mes fiscal [primer día, primer día del siguiente). */
function rango(year: number, month: number): [Date, Date] {
  return [new Date(year, month - 1, 1), new Date(year, month, 1)];
}

/** CFDI con sus filas de retención, como lo necesita el armado. */
export interface CfdiRetenciones {
  tipoSat: string | null;
  taxes: Array<{ tipo: string; importe: number }>;
}

export interface InsumosRetenciones {
  year: number;
  month: number;
  /** Recibos de nómina EMITIDOS del periodo, por régimen. */
  sueldos: { isrRetenido: number; recibos: number };
  asimilados: { isrRetenido: number; recibos: number };
  /** CFDIs recibidos con retención (lo que la empresa retuvo a proveedores). */
  retencionesAProveedores: CfdiRetenciones[];
  /** CFDIs emitidos con retención (lo que los clientes le retuvieron). */
  retencionesDeClientes: CfdiRetenciones[];
}

/**
 * Arma la posición de retenciones. Separado de la consulta para poder fijarlo
 * con casos golden: el entero del día 17 no admite «se ve bien».
 */
export function armarRetenciones(datos: InsumosRetenciones): RetencionesPeriodo {
  // Una nota de crédito netea con signo negativo dentro de su tipo: si se
  // canceló parte de la operación, la retención asociada también baja.
  const sumar = (filas: CfdiRetenciones[], tipo: "IVA" | "ISR") =>
    r2(
      filas.reduce(
        (s, f) =>
          s +
          (f.tipoSat === "E" ? -1 : 1) *
            f.taxes.filter((t) => t.tipo === tipo).reduce((a, t) => a + t.importe, 0),
        0
      )
    );
  const conFacturas = (tipo: "IVA" | "ISR") =>
    datos.retencionesAProveedores.filter((f) => f.taxes.some((t) => t.tipo === tipo)).length;

  const conceptos: RetencionConcepto[] = [
    {
      clave: "isr_sueldos",
      nombre: "ISR retenido por sueldos y salarios",
      fundamento: "Art. 96 LISR",
      monto: r2(datos.sueldos.isrRetenido),
      comprobantes: datos.sueldos.recibos,
    },
    {
      clave: "isr_asimilados",
      nombre: "ISR retenido por asimilados a salarios",
      fundamento: "Art. 94 LISR (régimen 05–11)",
      monto: r2(datos.asimilados.isrRetenido),
      comprobantes: datos.asimilados.recibos,
    },
    {
      clave: "isr_proveedores",
      nombre: "ISR retenido a personas físicas (honorarios y arrendamiento)",
      fundamento: "Art. 106 y 116 LISR",
      monto: sumar(datos.retencionesAProveedores, "ISR"),
      comprobantes: conFacturas("ISR"),
    },
    {
      clave: "iva_proveedores",
      nombre: "IVA retenido a proveedores",
      fundamento: "Art. 1-A LIVA",
      monto: sumar(datos.retencionesAProveedores, "IVA"),
      comprobantes: conFacturas("IVA"),
    },
    // Un concepto en cero SIN comprobantes no se muestra: un renglón vacío en
    // una declaración invita a buscar un error que no existe.
  ].filter((c) => c.monto !== 0 || c.comprobantes > 0);

  return {
    periodo: `${datos.year}-${String(datos.month).padStart(2, "0")}`,
    aEnterar: r2(conceptos.reduce((s, c) => s + c.monto, 0)),
    conceptos,
    aFavor: {
      iva: sumar(datos.retencionesDeClientes, "IVA"),
      isr: sumar(datos.retencionesDeClientes, "ISR"),
    },
    recibosNomina: datos.sueldos.recibos + datos.asimilados.recibos,
  };
}

export async function retencionesDelPeriodo(
  companyId: string,
  year: number,
  month: number
): Promise<RetencionesPeriodo> {
  const [desde, hasta] = rango(year, month);
  const fecha = { gte: desde, lt: hasta };
  const vigente = { not: "CANCELLED" as const };
  // El sync del SAT graba la procedencia en notas; los recibos que la empresa
  // EMITE son los que la vuelven retenedor. Un CFDI de nómina recibido es
  // ingreso de una persona física, no una obligación de la empresa.
  const emitidos = { notas: { contains: "emitid", mode: "insensitive" as const } };

  const [sueldos, asimilados, retProveedores, retClientes] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        companyId, tipo: "NOMINA", status: vigente, fecha, ...emitidos,
        NOT: { regimenNomina: { in: REGIMENES_ASIMILADOS } },
      },
      _sum: { isrRetenidoNomina: true },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: {
        companyId, tipo: "NOMINA", status: vigente, fecha, ...emitidos,
        regimenNomina: { in: REGIMENES_ASIMILADOS },
      },
      _sum: { isrRetenidoNomina: true },
      _count: { _all: true },
    }),
    // Retenciones a proveedores: viven en los impuestos del CFDI RECIBIDO.
    prisma.invoice.findMany({
      where: {
        companyId, tipo: "EGRESO", status: vigente, fecha,
        taxes: { some: { retencion: true } },
      },
      select: { tipoSat: true, taxes: { where: { retencion: true }, select: { tipo: true, importe: true } } },
    }).then((rows) => rows.map((f) => ({ ...f, taxes: f.taxes.map((t) => ({ ...t, importe: Number(t.importe) })) }))),
    // Lo retenido POR los clientes en los CFDIs que la empresa emitió.
    prisma.invoice.findMany({
      where: {
        companyId, tipo: "INGRESO", status: vigente, fecha,
        taxes: { some: { retencion: true } },
      },
      select: { tipoSat: true, taxes: { where: { retencion: true }, select: { tipo: true, importe: true } } },
    }).then((rows) => rows.map((f) => ({ ...f, taxes: f.taxes.map((t) => ({ ...t, importe: Number(t.importe) })) }))),
  ]);

  return armarRetenciones({
    year,
    month,
    sueldos: { isrRetenido: Number(sueldos._sum.isrRetenidoNomina ?? 0), recibos: sueldos._count._all },
    asimilados: { isrRetenido: Number(asimilados._sum.isrRetenidoNomina ?? 0), recibos: asimilados._count._all },
    retencionesAProveedores: retProveedores,
    retencionesDeClientes: retClientes,
  });
}
