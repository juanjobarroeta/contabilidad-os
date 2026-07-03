/**
 * POST /api/construccion/bank-transactions/auto-conciliar
 *
 * Corre el auto-conciliador fiscal (mismo motor que el cron: sólo empates de
 * alta confianza y sin ambigüedad) para toda la empresa. Espejo bearer del
 * POST /api/bancos/[id]/match para que bartiz lo dispare con un botón.
 *
 * Body: { companyId }
 * → { matched, total } (movimientos empatados / movimientos sin conciliar)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { autoConciliarCuenta } from "@/lib/bancos/auto-conciliar";

const bodySchema = z.object({ companyId: z.string().min(1) });

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "CONSTRUCCION");

  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
  });

  let matched = 0;
  let total = 0;
  for (const a of accounts) {
    try {
      const r = await autoConciliarCuenta(a.id);
      matched += r.matched;
      total += r.total;
    } catch {
      // best-effort: una cuenta con error no detiene las demás
    }
  }

  return NextResponse.json({ matched, total });
});
