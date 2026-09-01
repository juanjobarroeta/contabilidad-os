import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { sugerenciasPeriodo, aprobarSugerencia } from "@/lib/bancos/sugerencias-concepto";
import type { FamiliaConcepto } from "@/lib/bancos/categorizar-concepto";

const FAMILIAS_VALIDAS: FamiliaConcepto[] = [
  "COMISION",
  "TAX_PAYMENT",
  "PAYROLL_NO_CFDI",
  "INTERNAL_TRANSFER",
  "FINANCIAL_INCOME",
  "RENT",
  "NON_DEDUCTIBLE",
  "LOAN_RECEIVED",
  "LOAN_GIVEN",
];

/**
 * GET /api/bancos/sugerencias?companyId=&year=&month=&llm=1
 *
 * Lista los movimientos bancarios UNMATCHED SIN CFDI del periodo con la
 * categoría contable sugerida (reglas; con `llm=1` usa el fallback LLM acotado
 * para los que las reglas no clasifican). NO escribe en el ledger.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  const usarLLM = url.searchParams.get("llm") === "1";

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "year y month válidos requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const sugerencias = await sugerenciasPeriodo(companyId, year, month, { usarLLM });
  return NextResponse.json({ year, month, sugerencias });
}

/**
 * POST /api/bancos/sugerencias
 * Body: { txId: string, familia: FamiliaConcepto }
 *
 * APRUEBA una sugerencia: escribe el asiento (fuente BANCO) para ese movimiento
 * con la cuenta de la familia elegida, de forma idempotente. Es lo ÚNICO que
 * escribe en el ledger.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const txId: unknown = body?.txId;
  const familia: unknown = body?.familia;

  if (typeof txId !== "string" || !txId) {
    return NextResponse.json({ error: "txId requerido" }, { status: 400 });
  }
  if (typeof familia !== "string" || !FAMILIAS_VALIDAS.includes(familia as FamiliaConcepto)) {
    return NextResponse.json({ error: "familia inválida" }, { status: 400 });
  }

  // Authz: el movimiento pertenece a una empresa a la que el usuario tiene acceso.
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    select: { companyId: true },
  });
  if (!tx) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, tx.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const result = await aprobarSugerencia(txId, familia as FamiliaConcepto);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, created: result.created, entries: result.entries });
}
