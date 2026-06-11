import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { tarifaPeriodoPF, aplicarTarifa } from "@/lib/fiscal/tarifas";
import { calcularIsrResicoPf } from "@/lib/resico";

const IVA = 0.16;
const r2 = (n: number) => Math.round(n * 100) / 100;

// GET /api/impuestos/simular?companyId=x&month=6&year=2026&addIngreso=&addGasto=
//
// "What if I invoice one more ingreso / gasto this month?" Runs the REAL fiscal
// engine for the period (computeTaxPosition) and applies the hypothetical deltas
// with the same régimen math the engine uses — no placeholder formulas. Pure of
// side effects: nothing is written.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");
  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const addIngreso = Math.max(0, parseFloat(searchParams.get("addIngreso") ?? "0") || 0);
  const addGasto = Math.max(0, parseFloat(searchParams.get("addGasto") ?? "0") || 0);

  const pos = await computeTaxPosition(companyId, year, month);

  // ── IVA (flujo, base-REP): trasladado/acreditable move linearly with 16% ──
  // El gasto hipotético se prorratea con la proporción de acreditamiento del
  // periodo (Art. 5-V); el ingreso hipotético se asume gravado y la proporción
  // se mantiene constante (aproximación del simulador).
  const newTrasladado = pos.iva.trasladado + addIngreso * IVA;
  const newAcreditable =
    (pos.iva.acreditableBruto + addGasto * IVA) * pos.iva.proporcionAcreditamiento;
  const newIvaNeto =
    newTrasladado - newAcreditable - pos.iva.retenidoPorClientes - pos.iva.saldoFavorAnterior;
  const newIva = Math.max(0, r2(newIvaNeto));

  // ── ISR: re-run the régimen's own method against the new bases ────────────
  let newIsr: number | null;
  switch (pos.isr.metodo) {
    case "PM_ART14": {
      // Art. 14: utilidad = ingresos × coeficiente × 30%. Gasto NO reduce el
      // anticipo (el coeficiente sustituye a las deducciones). Sin coeficiente
      // no hay cálculo.
      const coef = pos.isr.coeficiente;
      if (coef == null) {
        newIsr = null;
      } else {
        const newUtilidad = (pos.isr.ingresosAcumulados + addIngreso) * coef;
        newIsr = Math.max(0, r2(newUtilidad * 0.3 - pos.isr.isrPagadoAnterior));
      }
      break;
    }
    case "PF_ACT_EMPRESARIAL": {
      // Art. 106: base flujo (cobrado − deducciones) × tarifa progresiva elevada.
      const periodo = tarifaPeriodoPF(year, month);
      if (!periodo) {
        newIsr = null;
      } else {
        const newBase = Math.max(0, (pos.isr.baseGravable ?? 0) + addIngreso - addGasto);
        const causado = aplicarTarifa(newBase, periodo.tarifa);
        newIsr = Math.max(
          0,
          r2(causado - pos.isr.isrPagadoAnterior - pos.isr.retencionesAcreditadas)
        );
      }
      break;
    }
    case "RESICO_PF": {
      // Art. 113-E: tarifa sobre ingresos del mes (definitivo), menos la
      // retención 1.25% de clientes PM (Art. 113-J) y el saldo a favor
      // arrastrado del periodo anterior.
      const causado = calcularIsrResicoPf(pos.isr.ingresosDelMes + addIngreso).isr;
      newIsr = Math.max(0, r2(causado - pos.isr.retencionesAcreditadas - pos.isr.saldoFavorAnterior));
      break;
    }
    default:
      newIsr = pos.isr.isrPagar;
  }

  return NextResponse.json({
    base: { iva: pos.iva.pagar, isr: pos.isr.isrPagar, total: pos.iva.pagar + (pos.isr.isrPagar ?? 0) },
    sim: { iva: newIva, isr: newIsr, total: newIva + (newIsr ?? 0) },
    metodo: pos.isr.metodo,
    tarifaVerificada: pos.isr.tarifaVerificada,
  });
}
