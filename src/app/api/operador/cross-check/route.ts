import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/operador/cross-check?companyId=…|rfc=…&periodo=YYYY-MM
//
// Operator-only, READ-ONLY. Returns the system's computed tax position for a
// company + period as JSON, shaped to cross-check against a SAT declaración
// (the accountant's filed numbers) without sharing DB credentials.
//
// Also reports the PRIOR-PERIOD CHAIN: which prior months of the year have a
// saved ISR_PROVISIONAL / IVA_MENSUAL declaration. That's the input the motor
// uses for "ISR pagado anterior" and "IVA saldo a favor" — when it's incomplete
// the monthly result diverges from what the accountant filed (the gap we found
// on Soluciones/Bartiz).
function round2(n: number | null | undefined): number | null {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rfc = url.searchParams.get("rfc");
  const companyIdParam = url.searchParams.get("companyId");
  const periodo = url.searchParams.get("periodo") ?? "";

  const m = /^(\d{4})-(\d{2})$/.exec(periodo.trim());
  if (!m) return NextResponse.json({ error: "periodo requerido en formato YYYY-MM" }, { status: 400 });
  const year = parseInt(m[1]);
  const month = parseInt(m[2]);
  if (month < 1 || month > 12) return NextResponse.json({ error: "mes inválido" }, { status: 400 });

  const company = companyIdParam
    ? await prisma.company.findUnique({
        where: { id: companyIdParam },
        select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true },
      })
    : rfc
      ? await prisma.company.findFirst({
          where: { rfc: { equals: rfc.trim(), mode: "insensitive" } },
          select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true },
        })
      : null;
  if (!company) return NextResponse.json({ error: "Empresa no encontrada (usa companyId o rfc)" }, { status: 404 });

  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const [pos, emitidas, recibidas, priorDecls] = await Promise.all([
    computeTaxPosition(company.id, year, month),
    prisma.invoice.count({ where: { companyId: company.id, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } } }),
    prisma.invoice.count({ where: { companyId: company.id, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } } }),
    // Prior months of THIS year with a saved declaration — the carryover chain.
    prisma.taxDeclaration.findMany({
      where: {
        companyId: company.id,
        tipo: { in: ["ISR_PROVISIONAL", "IVA_MENSUAL"] },
        periodo: { gte: `${year}-01`, lt: periodo },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { tipo: true, periodo: true, isrPagar: true, ivaSaldoFavor: true, status: true },
      orderBy: { periodo: "asc" },
    }),
  ]);

  // Which prior months (Jan..month-1) are missing each declaration tipo?
  const expectedMonths: string[] = [];
  for (let mm = 1; mm < month; mm++) expectedMonths.push(`${year}-${String(mm).padStart(2, "0")}`);
  const have = (tipo: string) => new Set(priorDecls.filter((d) => d.tipo === tipo).map((d) => d.periodo));
  const isrHave = have("ISR_PROVISIONAL");
  const ivaHave = have("IVA_MENSUAL");

  return NextResponse.json({
    company: { id: company.id, rfc: company.rfc, razonSocial: company.razonSocial, regimenFiscal: company.regimenFiscal },
    periodo,
    facturas: { emitidas, recibidas },
    iva: {
      causado: round2(pos.iva.trasladado),
      acreditable: round2(pos.iva.acreditable),
      acreditableBruto: round2(pos.iva.acreditableBruto),
      proporcionAcreditamiento: pos.iva.proporcionAcreditamiento,
      retenidoPorClientes: round2(pos.iva.retenidoPorClientes),
      saldoFavorAnterior: round2(pos.iva.saldoFavorAnterior),
      aPagar: round2(pos.iva.pagar),
      saldoAFavor: round2(pos.iva.saldoAFavor),
    },
    isr: {
      metodo: pos.isr.metodo,
      ingresosAcumulados: round2(pos.isr.ingresosAcumulados),
      coeficiente: pos.isr.coeficiente,
      coeficienteFuente: pos.isr.coeficienteFuente,
      coeficienteSugerido: pos.isr.coeficienteSugerido ?? null,
      coeficienteSugeridoFuente: pos.isr.coeficienteSugeridoFuente ?? null,
      utilidadFiscal: round2(pos.isr.utilidadFiscal),
      isrDelEjercicio: round2(pos.isr.isrDelEjercicio),
      isrPagadoAnterior: round2(pos.isr.isrPagadoAnterior),
      isrPagar: round2(pos.isr.isrPagar),
    },
    // The carryover chain — the usual source of divergence vs the filed return.
    cadenaPrevia: {
      mesesEsperados: expectedMonths,
      isrProvisional: {
        capturados: [...isrHave].sort(),
        faltantes: expectedMonths.filter((p) => !isrHave.has(p)),
        sumaIsrPagar: round2(priorDecls.filter((d) => d.tipo === "ISR_PROVISIONAL").reduce((s, d) => s + Number(d.isrPagar ?? 0), 0)),
      },
      ivaMensual: {
        capturados: [...ivaHave].sort(),
        faltantes: expectedMonths.filter((p) => !ivaHave.has(p)),
        ultimoSaldoFavor: round2(
          Number(priorDecls.filter((d) => d.tipo === "IVA_MENSUAL").at(-1)?.ivaSaldoFavor ?? 0)
        ),
      },
    },
  });
}
