import { NextResponse } from "next/server";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { checklistDeclaracion } from "@/lib/fiscal/checklist-declaracion";
import { retencionesDelPeriodo } from "@/lib/fiscal/retenciones";
import { isrRetenidoMedicosDelPeriodo } from "@/lib/hospital/isr-medicos";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hospital/fiscal?companyId=…&year=2026&month=8
//
// «Impuestos del mes» para el satélite Hospital: la MISMA posición fiscal que
// calcula el hub (computeTaxPosition — IVA en flujo Art. 1-B, ISR provisional
// por régimen), el checklist de la declaración y las retenciones a enterar,
// más el renglón propio de un hospital: el ISR retenido a los MÉDICOS
// (honorarios de personas físicas, 10 % Art. 106 LISR). Solo lectura.
//
// Sin year/month, el periodo por defecto es el MES ANTERIOR — el que está por
// declararse (vence el 17 del mes en curso), que es la pregunta del negocio.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const previo = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const year = Number(searchParams.get("year") ?? previo.getFullYear());
  const month = Number(searchParams.get("month") ?? previo.getMonth() + 1);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }

  // El checklist ya corre el motor por dentro para sus banderas; la corrida
  // extra trae el desglose completo. Paralelo para no sumar latencia.
  const [pos, checklist, retenciones, medicos] = await Promise.all([
    computeTaxPosition(companyId, year, month),
    checklistDeclaracion(companyId, year, month, hoy),
    retencionesDelPeriodo(companyId, year, month),
    isrRetenidoMedicosDelPeriodo(prisma, companyId, year, month),
  ]);

  // Lo que realmente sale del banco el día 17: impuesto propio (IVA + ISR
  // provisional) MÁS las retenciones, que no son de la empresa pero las entera
  // ella. El ISR de los médicos ya está DENTRO de `retenciones.aEnterar`
  // (concepto isr_proveedores); se enseña aparte, no se suma dos veces.
  const totalSat =
    Math.round(
      (Math.max(pos.iva.pagar, 0) + Math.max(pos.isr.isrPagar ?? 0, 0) + retenciones.aEnterar) * 100
    ) / 100;

  return NextResponse.json({
    periodo: pos.periodo,
    year,
    month,
    fechaLimite: checklist.fechaLimite,
    diasRestantes: checklist.diasRestantes,
    vencida: checklist.vencida,
    iva: pos.iva,
    isr: pos.isr,
    retenciones,
    isrRetenidoMedicos: medicos.monto,
    isrRetenidoMedicosComprobantes: medicos.comprobantes,
    totalSat,
    efos: pos.efos ?? null,
    advertencias: pos.advertencias,
    checklist: { items: checklist.items, resumen: checklist.resumen },
  });
});
