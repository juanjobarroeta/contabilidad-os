import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { cargarConfigContable, resolverCuenta } from "../hospital/contabilidad";

/**
 * EL CFDI DEL MÉDICO CANCELA EL PASIVO, NO ES OTRO GASTO.
 *
 * Con `HospConfig.contabilidadActiva`, el CFDI del paciente manda los
 * honorarios del médico a HONORARIOS_POR_CUENTA_DE_TERCEROS (205.06): el
 * hospital los cobró por cuenta del médico y se los debe. Cuando el médico
 * factura sus honorarios al hospital, el motor posteaba ese CFDI como una
 * compra más —gasto + proveedor—, así que el honorario quedaba DOS veces: una
 * en el pasivo (que nunca se cancelaba) y otra en resultados.
 *
 * Aquí se decide cuánto de cada CFDI de un médico cancela el pasivo en vez de
 * ir a gasto: lo que el hospital le facturó al paciente por ese médico y aún no
 * se ha cancelado con CFDIs anteriores del mismo médico, en orden cronológico.
 * Lo que exceda (el médico facturó más de lo que el hospital cobró por él)
 * sigue a gasto y el motor lo avisa: es una diferencia que el contador tiene
 * que explicar, no algo que se deba absorber callado.
 *
 * LA RETENCIÓN SALE DEL CFDI DEL MÉDICO. La retención de ISR (10 %) y de IVA
 * (2/3) a un médico persona física nace del comprobante que él emite y del
 * pago (Art. 106 LISR, Art. 1-A LIVA), y el motor fiscal la toma de ahí. El
 * módulo asentaba además una retención estimada al alta del episodio; con las
 * dos, el pasivo con el SAT quedaba doble. Ya no se asienta al alta
 * (hospital/asientos.ts): el CFDI del médico es la única fuente.
 *
 * El importe del pasivo por médico se lee de los HospCargo HONORARIO ligados
 * a un CFDI de ingreso vigente: es la mezcla con la que hospital.ts reparte el
 * subtotal del CFDI del paciente, así que es el mismo monto salvo el redondeo
 * del reparto.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;
const normRfc = (rfc: string | null | undefined) => (rfc ?? "").trim().toUpperCase();

export type EventoHonorario =
  | { tipo: "FACTURADO"; rfc: string; fecha: Date; monto: number }
  | { tipo: "CFDI_MEDICO"; invoiceId: string; rfc: string; fecha: Date; subtotal: number };

/**
 * Cuánto de cada CFDI de médico cancela el pasivo. PURA.
 * El mismo día, lo facturado al paciente va antes que el CFDI del médico.
 */
export function honorariosAlPasivo(eventos: EventoHonorario[]): Map<string, number> {
  const orden = [...eventos].sort(
    (a, b) => a.fecha.getTime() - b.fecha.getTime() || (a.tipo === b.tipo ? 0 : a.tipo === "FACTURADO" ? -1 : 1),
  );
  const pendiente = new Map<string, number>();
  const out = new Map<string, number>();
  for (const e of orden) {
    const rfc = normRfc(e.rfc);
    if (e.tipo === "FACTURADO") {
      pendiente.set(rfc, r2((pendiente.get(rfc) ?? 0) + e.monto));
      continue;
    }
    const disponible = pendiente.get(rfc) ?? 0;
    const aPasivo = r2(Math.max(0, Math.min(e.subtotal, disponible)));
    pendiente.set(rfc, r2(disponible - aPasivo));
    out.set(e.invoiceId, aPasivo);
  }
  return out;
}

export interface ContextoHonorariosHospital {
  activa: boolean;
  cuenta: { id: string } | null;
  /** invoiceId del CFDI del médico → monto (sin IVA) que va al pasivo 205.06. */
  porInvoice: Map<string, number>;
  /** CFDIs de médicos del mes que no encontraron honorarios pendientes (siguen a gasto). */
  sinPasivo: Set<string>;
}

export const SIN_HONORARIOS_HOSPITAL: ContextoHonorariosHospital = {
  activa: false,
  cuenta: null,
  porInvoice: new Map(),
  sinPasivo: new Set(),
};

export async function cargarHonorariosHospital(
  companyId: string,
  periodo: { start: Date; end: Date },
  opts: { db?: Db } = {},
): Promise<ContextoHonorariosHospital> {
  const db = opts.db ?? prisma;
  const config = await cargarConfigContable(db, companyId);
  if (!config.activa) return SIN_HONORARIOS_HOSPITAL;

  const medicos = await db.hospMedico.findMany({
    where: { companyId },
    select: { id: true, rfc: true, supplier: { select: { rfc: true } } },
  });
  const rfcDe = new Map<string, string>();
  for (const m of medicos) {
    const rfc = normRfc(m.rfc ?? m.supplier?.rfc);
    if (rfc) rfcDe.set(m.id, rfc);
  }
  const rfcs = [...new Set(rfcDe.values())];
  if (rfcs.length === 0) return { ...SIN_HONORARIOS_HOSPITAL, activa: true };

  // Toda la historia hasta el fin del mes: el pendiente de hoy depende de lo
  // facturado y lo cancelado antes. Son pocos renglones (médicos).
  const [facturados, cfdisMedico] = await Promise.all([
    db.hospCargo.findMany({
      where: {
        companyId,
        categoria: "HONORARIO",
        cancelado: false,
        medicoId: { in: [...rfcDe.keys()] },
        invoice: { status: "STAMPED", tipo: "INGRESO", fecha: { lt: periodo.end } },
      },
      select: { medicoId: true, importe: true, invoice: { select: { fecha: true } } },
    }),
    db.invoice.findMany({
      where: {
        companyId,
        tipo: "EGRESO",
        status: "STAMPED",
        fecha: { lt: periodo.end },
        NOT: { tipoSat: "E" },
        OR: [{ contraparteRfc: { in: rfcs } }, { customer: { rfc: { in: rfcs } } }],
      },
      select: { id: true, fecha: true, subtotal: true, contraparteRfc: true, customer: { select: { rfc: true } } },
    }),
  ]);

  const eventos: EventoHonorario[] = [
    ...facturados
      .filter((c) => c.medicoId && c.invoice)
      .map((c) => ({ tipo: "FACTURADO" as const, rfc: rfcDe.get(c.medicoId!)!, fecha: c.invoice!.fecha, monto: Number(c.importe) })),
    ...cfdisMedico.map((i) => ({
      tipo: "CFDI_MEDICO" as const,
      invoiceId: i.id,
      rfc: normRfc(i.contraparteRfc ?? i.customer?.rfc),
      fecha: i.fecha,
      subtotal: Number(i.subtotal),
    })),
  ];
  const todos = honorariosAlPasivo(eventos);

  const delMes = new Set(cfdisMedico.filter((i) => i.fecha >= periodo.start).map((i) => i.id));
  const porInvoice = new Map<string, number>();
  const sinPasivo = new Set<string>();
  for (const id of delMes) {
    const monto = todos.get(id) ?? 0;
    if (monto > 0.005) porInvoice.set(id, monto);
    else sinPasivo.add(id);
  }
  const cuenta = porInvoice.size > 0
    ? { id: (await resolverCuenta(db, companyId, "HONORARIOS_POR_CUENTA_DE_TERCEROS", { config: config.cuentas })).id }
    : null;
  return { activa: true, cuenta, porInvoice, sinPasivo };
}
