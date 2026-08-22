import { NextResponse } from "next/server";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { checklistDeclaracion } from "@/lib/fiscal/checklist-declaracion";
import { retencionesDelPeriodo } from "@/lib/fiscal/retenciones";
import { isanDelPeriodo } from "@/lib/automotriz/isan-periodo";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/fiscal?companyId=…&year=2026&month=7
//
// "Impuestos del mes" para el satélite: la MISMA posición fiscal que calcula el
// hub (computeTaxPosition — IVA en flujo Art. 1-B, ISR provisional por régimen)
// más el checklist de la declaración (¿qué falta para declarar?), en una sola
// respuesta bearer-aware. Solo lectura: el cálculo no escribe nada.
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
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const hoy = new Date();
  const previo = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const year = Number(searchParams.get("year") ?? previo.getFullYear());
  const month = Number(searchParams.get("month") ?? previo.getMonth() + 1);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }

  // El checklist ya corre el motor por dentro para sus banderas; la corrida
  // extra trae el desglose completo. Paralelo para no sumar latencia.
  const [pos, checklist, retenciones, isan] = await Promise.all([
    computeTaxPosition(companyId, year, month),
    checklistDeclaracion(companyId, year, month, hoy),
    retencionesDelPeriodo(companyId, year, month),
    // ISAN: el impuesto propio de una distribuidora. Se entera en pagos
    // provisionales el día 17 (Art. 4 LFISAN) — el mismo día que el IVA y el
    // ISR, así que se calcula aquí y no en una pantalla aparte.
    isanDelPeriodo(prisma, companyId, year, month),
  ]);

  // Lo que realmente sale del banco el día 17: impuesto propio (IVA + ISR
  // provisional) MÁS las retenciones, que no son de la empresa pero las entera
  // ella. Verlos separados y sumados evita las dos sorpresas clásicas: creer
  // que sólo se debe el IVA, o contar la retención como si fuera gasto propio.
  const totalSat =
    Math.round(
      (Math.max(pos.iva.pagar, 0) +
        Math.max(pos.isr.isrPagar ?? 0, 0) +
        retenciones.aEnterar +
        // El ISAN va en el mismo total: sale del mismo banco el mismo día.
        // Omitirlo hacía que «lo que se le debe al SAT» estuviera corto justo
        // en el impuesto que distingue a una distribuidora.
        Math.max(isan.total, 0)) *
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
    isan,
    totalSat,
    efos: pos.efos ?? null,
    // Las del motor MÁS las del ISAN: tarifa sin cotejar, unidades sin precio,
    // impuesto causado que no quedó registrado en la unidad.
    advertencias: [...pos.advertencias, ...isan.advertencias],
    checklist: { items: checklist.items, resumen: checklist.resumen },
  });
});
