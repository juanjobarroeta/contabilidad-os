import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";

// PATCH /api/rentabilidad/plan  body: { companyId, plan }
// Fija el plan/tier de una empresa (define el gating de COGS: Syntage/banco/
// WhatsApp). Sólo operador.

const PLANES = ["ASISTENTE", "AUTOMATIZADO", "PRO", "DESPACHO"] as const;

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { companyId, plan } = body ?? {};
  if (typeof companyId !== "string" || !companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  if (!PLANES.includes(plan)) {
    return NextResponse.json({ error: "plan inválido" }, { status: 400 });
  }

  await prisma.company.update({ where: { id: companyId }, data: { tier: plan } });
  return NextResponse.json({ ok: true, companyId, plan });
}
