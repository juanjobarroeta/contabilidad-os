import { NextResponse } from "next/server";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { checklistDeclaracion } from "@/lib/fiscal/checklist-declaracion";
import { retencionesDelPeriodo } from "@/lib/fiscal/retenciones";
import { iepsDelPeriodo } from "@/lib/salameria/ieps";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/salameria/fiscal?companyId=…&year=2026&month=8
//
// «Impuestos del mes» para el satélite Salamería: la MISMA posición fiscal que
// calcula el hub (computeTaxPosition — IVA en flujo Art. 1-B, ISR provisional
// por régimen), el checklist de la declaración y las retenciones a enterar.
//
// No se recalcula nada aquí: el motor fiscal es del hub y esta ruta sólo lo
// expone al satélite. Un segundo cálculo en el módulo daría dos cifras
// distintas para el mismo mes, y la del satélite sería la equivocada.
//
// Sin year/month el periodo por defecto es el MES ANTERIOR — el que está por
// declararse (vence el 17 del mes en curso), que es la pregunta del negocio.
// Sólo lectura.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const hoy = new Date();
  const previo = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const year = Number(searchParams.get("year") ?? previo.getFullYear());
  const month = Number(searchParams.get("month") ?? previo.getMonth() + 1);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    year < 2000 ||
    year > 2100
  ) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }

  // El checklist ya corre el motor por dentro para sus banderas; la corrida
  // extra trae el desglose completo. Paralelo para no sumar latencia.
  const [pos, checklist, retenciones, ieps] = await Promise.all([
    computeTaxPosition(companyId, year, month),
    checklistDeclaracion(companyId, year, month, hoy),
    retencionesDelPeriodo(companyId, year, month),
    // El motor del hub no calcula IEPS todavía; esto suma lo que los CFDIs ya
    // dicen para que la pantalla no lo omita en silencio. Ver lib/salameria/ieps.ts.
    iepsDelPeriodo(prisma, companyId, year, month),
  ]);

  // Lo que realmente sale del banco el día 17: impuesto propio (IVA + ISR
  // provisional) MÁS las retenciones, que no son de la empresa pero las entera
  // ella.
  //
  // OJO: el IEPS NO se suma aquí. Se conoce el trasladado y el pagado, pero no
  // cuánto es acreditable (Art. 4 LIEPS limita el acreditamiento por inciso), y
  // meter un neto sin esa regla daría un total con aire de exacto que puede
  // estar equivocado por decenas de miles. Va aparte y etiquetado.
  const totalSat =
    Math.round(
      (Math.max(pos.iva.pagar, 0) +
        Math.max(pos.isr.isrPagar ?? 0, 0) +
        retenciones.aEnterar) *
        100
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
    totalSat,
    /** Derivado de CFDIs, NO posición fiscal. `totalSat` no lo incluye. */
    ieps,
    iepsEnTotal: false,
    efos: pos.efos ?? null,
    advertencias: pos.advertencias,
    checklist: { items: checklist.items, resumen: checklist.resumen },
  });
});
