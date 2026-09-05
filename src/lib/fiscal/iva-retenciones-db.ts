// IVA retenido a proveedores ENTERADO en un periodo, con base en flujo (Art.
// 1-A LIVA): PUE al emitirse, PPD con cada pago de REP prorrateado. Lo usan el
// motor mensual y el papel de trabajo para el acreditamiento diferido del
// Art. 5-IV: lo enterado en el mes anterior es acreditable en éste.
//
// Supuesto documentado: la retención del mes se entera en la declaración de
// ese mes (a más tardar el 17 del siguiente). Si el contribuyente enteró tarde,
// el acreditamiento se corre igual que el entero — eso no lo sabe el sistema.
import { prisma } from "@/lib/prisma";
import { normalizarUuid, variantesUuid } from "./uuid";
import { repIvaRetenidoDe } from "./iva-retenciones";

export async function ivaRetenidoAProveedoresEnPeriodo(
  companyId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const [puePos, pueNeg, repLinks] = await Promise.all([
    // PUE: retención al emitirse. Las notas de crédito ("E") netean en negativo.
    prisma.invoiceTax.aggregate({
      where: {
        tipo: "IVA",
        retencion: true,
        invoice: { companyId, tipo: "EGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to }, NOT: { tipoSat: "E" } },
      },
      _sum: { importe: true },
    }),
    prisma.invoiceTax.aggregate({
      where: {
        tipo: "IVA",
        retencion: true,
        invoice: { companyId, tipo: "EGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to }, tipoSat: "E" },
      },
      _sum: { importe: true },
    }),
    prisma.pagoDoctoRelacionado.findMany({
      where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" } },
      select: { parentUuid: true, impPagado: true },
    }),
  ]);

  let total = Number(puePos._sum.importe ?? 0) - Number(pueNeg._sum.importe ?? 0);

  if (repLinks.length > 0) {
    const parents = await prisma.invoice.findMany({
      where: { companyId, uuid: { in: variantesUuid(repLinks.map((l) => l.parentUuid)) }, tipo: "EGRESO", metodoPago: "PPD", status: "STAMPED" },
      select: { uuid: true, total: true, totalImpuestos: true, taxes: { select: { tipo: true, retencion: true, importe: true } } },
    });
    const byUuid = new Map(
      parents.map((p) => [
        normalizarUuid(p.uuid!),
        { total: Number(p.total), totalImpuestos: p.totalImpuestos === null ? null : Number(p.totalImpuestos), taxes: p.taxes.map((t) => ({ ...t, importe: Number(t.importe) })) },
      ]),
    );
    for (const l of repLinks) {
      const parent = byUuid.get(normalizarUuid(l.parentUuid));
      if (!parent) continue;
      total += repIvaRetenidoDe({ impPagado: l.impPagado === null ? null : Number(l.impPagado) }, parent);
    }
  }

  return Math.round(total * 100) / 100;
}
