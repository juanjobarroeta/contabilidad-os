import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership } from "@/lib/authz";
import { descargasPorUuid } from "@/lib/nomina/recibos-descarga";
import { normalizarUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/hub?companyId=xxx — datos del Resumen del hub de Nómina que
// la lista de corridas no trae:
//   - recientes: últimos recibos TIMBRADOS (empleado, periodo, neto, UUID y
//     enlaces de descarga PDF/XML resueltos por UUID).
//   - mes: desglose agregado del mes en curso (percepciones y deducciones por
//     concepto, carga patronal y avance de timbrado) sumado sobre los items
//     de las corridas con fecha de pago en el mes.
// Sólo lectura — cualquier miembro (VIEWER incluido).
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    await requireMembership(companyId, undefined, req);

    // ── Últimos recibos timbrados ──
    const items = await prisma.payrollItem.findMany({
      where: { payrollRun: { companyId }, cfdiUuid: { not: null } },
      orderBy: [{ payrollRun: { fechaPago: "desc" } }, { id: "asc" }],
      take: 8,
      select: {
        id: true,
        cfdiUuid: true,
        netoAPagar: true,
        totalPercepciones: true,
        employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } },
        payrollRun: { select: { periodo: true, fechaPago: true, tipo: true, origen: true } },
      },
    });
    const descargas = await descargasPorUuid(companyId, items.map((i) => i.cfdiUuid));
    const recientes = items.map((i) => {
      const d = i.cfdiUuid ? descargas.get(normalizarUuid(i.cfdiUuid)) : undefined;
      return {
        id: i.id,
        empleado: `${i.employee.nombre} ${i.employee.apellidoPaterno}`,
        rfc: i.employee.rfc,
        periodo: i.payrollRun.periodo,
        fechaPago: i.payrollRun.fechaPago,
        tipo: i.payrollRun.tipo,
        origen: i.payrollRun.origen,
        neto: i.netoAPagar,
        cfdiUuid: i.cfdiUuid,
        invoiceId: d?.invoiceId ?? null,
        pdfDisponible: d?.pdfDisponible ?? false,
        xmlDisponible: d?.xmlDisponible ?? false,
      };
    });

    // ── Desglose del mes en curso (por fecha de pago) ──
    const now = new Date();
    const desde = new Date(now.getFullYear(), now.getMonth(), 1);
    const hasta = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const delMes = await prisma.payrollItem.findMany({
      where: { payrollRun: { companyId, fechaPago: { gte: desde, lt: hasta } } },
      select: {
        sueldoBase: true, horasExtra: true, bonosPagoFijo: true, bonosPagoVar: true,
        vales: true, otrasPercepciones: true, aguinaldo: true, primaVacacional: true,
        vacaciones: true, ptu: true,
        isrRetenido: true, imssObrero: true, imssPatronal: true, infonavit: true,
        otrasDeducc: true, totalPercepciones: true, totalDeducciones: true,
        netoAPagar: true, cfdiUuid: true,
      },
    });
    const sum = (f: (i: (typeof delMes)[number]) => number) =>
      Math.round(delMes.reduce((s, i) => s + f(i), 0) * 100) / 100;
    const mes = {
      recibos: delMes.length,
      timbrados: delMes.filter((i) => i.cfdiUuid).length,
      sueldos: sum((i) => i.sueldoBase),
      horasExtra: sum((i) => i.horasExtra),
      bonosComisiones: sum((i) => i.bonosPagoFijo + i.bonosPagoVar),
      valesOtras: sum((i) => i.vales + i.otrasPercepciones),
      especiales: sum((i) => i.aguinaldo + i.primaVacacional + i.vacaciones + i.ptu),
      isr: sum((i) => i.isrRetenido),
      imssObrero: sum((i) => i.imssObrero),
      infonavit: sum((i) => i.infonavit),
      otrasDeducciones: sum((i) => i.otrasDeducc),
      imssPatronal: sum((i) => i.imssPatronal),
      totalPercepciones: sum((i) => i.totalPercepciones),
      totalDeducciones: sum((i) => i.totalDeducciones),
      neto: sum((i) => i.netoAPagar),
    };

    return NextResponse.json({ recientes, mes });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
