import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// POST /api/impuestos/saldo-favor  { companyId, year, month, saldoFavor }
// Fija el saldo a favor de IVA de meses anteriores que se aplica en el periodo
// (override manual). Persiste en el MISMO campo que usa la pantalla de detalle:
// ivaSaldoFavorAnterior de la declaración IVA_MENSUAL del periodo. Lo usa el
// editor inline del papel de trabajo de IVA. Pasar saldoFavor = null restablece
// el valor automático (arrastre del mes anterior).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { companyId } = body ?? {};
    const year = parseInt(String(body?.year ?? ""));
    const month = parseInt(String(body?.month ?? ""));
    const reset = body?.saldoFavor === null || body?.saldoFavor === undefined || body?.saldoFavor === "";
    const saldoFavor = reset ? null : Number(body?.saldoFavor);

    if (!companyId || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
    }
    if (!reset && (!Number.isFinite(saldoFavor as number) || (saldoFavor as number) < 0)) {
      return NextResponse.json({ error: "saldoFavor fuera de rango" }, { status: 400 });
    }
    await requireWriter(companyId, req);

    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const redondeado = reset ? null : Math.round((saldoFavor as number) * 100) / 100;

    // Upsert por (companyId, tipo, periodo) — misma fila que detalle e /api/impuestos.
    const existing = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "IVA_MENSUAL", periodo },
      select: { id: true },
    });
    if (existing) {
      await prisma.taxDeclaration.update({
        where: { id: existing.id },
        data: { ivaSaldoFavorAnterior: redondeado },
      });
    } else {
      await prisma.taxDeclaration.create({
        data: {
          companyId,
          tipo: "IVA_MENSUAL",
          periodo,
          status: "CALCULATED",
          ivaSaldoFavorAnterior: redondeado,
        },
      });
    }

    return NextResponse.json({ ok: true, saldoFavor: redondeado, periodo });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
