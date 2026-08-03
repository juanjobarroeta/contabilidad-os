import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/contabilidad/saldos-interempresa?companyId=xxx
//
// Returns the loan balances (préstamos otorgados + préstamos por pagar) for
// ALL companies in the same despacho, so the user sees a cross-company net
// position. Each row = one company with its outstanding loans given/received.
//
// Cuentas oficiales (ver COE_CODES): préstamos interempresa = partes
// relacionadas nacionales, activo 107.03 / pasivo 205.04.
import { COE_CODES } from "@/lib/contabilidad/catalog";

const LOAN_GIVEN_SUBCUENTA = COE_CODES.PRESTAMOS_OTORGADOS;
const LOAN_RECEIVED_SUBCUENTA = COE_CODES.PRESTAMOS_RECIBIDOS;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Find all companies in the same despacho
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { despachoId: true },
  });

  let companyIds: string[] = [companyId];
  if (company?.despachoId) {
    const despachoCompanies = await prisma.company.findMany({
      where: { despachoId: company.despachoId, isActive: true },
      select: { id: true, rfc: true, razonSocial: true },
    });
    companyIds = despachoCompanies.map((c) => c.id);
  }

  // For each company, get the net balance on loan accounts
  const results: {
    companyId: string;
    rfc: string;
    razonSocial: string;
    prestamosOtorgados: number; // saldo deudor = what others owe us
    prestamosPorPagar: number;  // saldo acreedor = what we owe others
    neto: number;               // positive = net lender, negative = net borrower
  }[] = [];

  for (const cId of companyIds) {
    const comp = await prisma.company.findUnique({
      where: { id: cId },
      select: { rfc: true, razonSocial: true },
    });
    if (!comp) continue;

    // Get chart account IDs for loan accounts in this company
    const loanGivenAccount = await prisma.chartAccount.findFirst({
      where: { companyId: cId, subcuenta: LOAN_GIVEN_SUBCUENTA },
      select: { id: true },
    });
    const loanReceivedAccount = await prisma.chartAccount.findFirst({
      where: { companyId: cId, subcuenta: LOAN_RECEIVED_SUBCUENTA },
      select: { id: true },
    });

    let prestamosOtorgados = 0;
    let prestamosPorPagar = 0;

    if (loanGivenAccount) {
      const entries = await prisma.accountingEntry.findMany({
        where: { companyId: cId, chartAccountId: loanGivenAccount.id },
        select: { monto: true, tipo: true },
      });
      // ACTIVO: saldo deudor = sum(CARGO) - sum(ABONO)
      for (const e of entries) {
        if (e.tipo === "CARGO") prestamosOtorgados += e.monto;
        else prestamosOtorgados -= e.monto;
      }
    }

    if (loanReceivedAccount) {
      const entries = await prisma.accountingEntry.findMany({
        where: { companyId: cId, chartAccountId: loanReceivedAccount.id },
        select: { monto: true, tipo: true },
      });
      // PASIVO: saldo acreedor = sum(ABONO) - sum(CARGO)
      for (const e of entries) {
        if (e.tipo === "ABONO") prestamosPorPagar += e.monto;
        else prestamosPorPagar -= e.monto;
      }
    }

    results.push({
      companyId: cId,
      rfc: comp.rfc,
      razonSocial: comp.razonSocial,
      prestamosOtorgados: Math.round(prestamosOtorgados * 100) / 100,
      prestamosPorPagar: Math.round(prestamosPorPagar * 100) / 100,
      neto: Math.round((prestamosOtorgados - prestamosPorPagar) * 100) / 100,
    });
  }

  // Sort: companies with activity first, then alphabetical
  results.sort((a, b) => {
    const aHas = Math.abs(a.neto) > 0 ? 0 : 1;
    const bHas = Math.abs(b.neto) > 0 ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.razonSocial.localeCompare(b.razonSocial);
  });

  return NextResponse.json({ rows: results });
}
