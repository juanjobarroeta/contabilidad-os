import { prisma } from "@/lib/prisma";
import { REGIMENES_ASIMILADOS, etiquetaRegimenNomina } from "@/lib/nomina/regimen";

// ─────────────────────────────────────────────────────────────────────────────
// Resumen de ingresos por ASIMILADOS A SALARIOS (Art. 94 LISR) recibidos.
//
// Fuente única para las tres superficies (impuestos, cierre, dashboard): los
// recibos de nómina RECIBIDOS de un tercero bajo régimen asimilados (05–11). El
// retenedor retiene el ISR (= pago provisional del receptor) y se acredita en la
// anual; NO entra a la base de actividad empresarial. Devuelve null cuando la
// empresa no recibe asimilados (para no pintar tarjetas vacías).
// ─────────────────────────────────────────────────────────────────────────────

export interface AsimiladoRecibo {
  id: string;
  uuid: string | null;
  fecha: Date;
  emisor: string;
  rfc: string;
  regimenLabel: string | null;
  ingreso: number;
  isrRetenido: number;
  esDelMes: boolean;
}

export interface AsimiladosResumen {
  recibos: AsimiladoRecibo[];
  mes: { ingreso: number; isrRetenido: number };
  anual: { ingreso: number; isrRetenido: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));

/**
 * @param to  Cota superior (exclusiva) del periodo — permite precierre con
 *            fecha de corte. Si se omite, usa el inicio del mes siguiente.
 */
export async function getAsimiladosResumen(
  companyId: string,
  year: number,
  month: number,
  to?: Date
): Promise<AsimiladosResumen | null> {
  const yearFrom = new Date(year, 0, 1);
  const from = new Date(year, month - 1, 1);
  const upper = to ?? new Date(year, month, 1);

  const rows = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "NOMINA",
      status: "STAMPED",
      regimenNomina: { in: REGIMENES_ASIMILADOS },
      notas: { contains: "recib", mode: "insensitive" }, // recibidos = ingreso del receptor
      fecha: { gte: yearFrom, lt: upper },
    },
    select: {
      id: true, uuid: true, fecha: true, subtotal: true,
      isrRetenidoNomina: true, regimenNomina: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
    orderBy: { fecha: "asc" },
  });
  if (rows.length === 0) return null;

  const recibos: AsimiladoRecibo[] = rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    fecha: r.fecha,
    emisor: r.customer?.razonSocial ?? "—",
    rfc: r.customer?.rfc ?? "—",
    regimenLabel: etiquetaRegimenNomina(r.regimenNomina),
    ingreso: r.subtotal,
    isrRetenido: r.isrRetenidoNomina ?? 0,
    esDelMes: new Date(r.fecha) >= from,
  }));
  const delMes = recibos.filter((r) => r.esDelMes);

  return {
    recibos,
    mes:   { ingreso: sum(delMes.map((r) => r.ingreso)),   isrRetenido: sum(delMes.map((r) => r.isrRetenido)) },
    anual: { ingreso: sum(recibos.map((r) => r.ingreso)), isrRetenido: sum(recibos.map((r) => r.isrRetenido)) },
  };
}
