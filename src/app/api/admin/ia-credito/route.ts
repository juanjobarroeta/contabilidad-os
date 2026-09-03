import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { estadoIAEmpresa, periodoActualMx } from "@/lib/ai/guardia";

// POST /api/admin/ia-credito  { companyId, usd, nota?, periodo? }
//
// Cortesía / ajuste del operador de plataforma: amplía el tope mensual de IA de
// una empresa sin pasar por Stripe (cliente en negociación, incidente, prueba
// extendida). Queda en AiCreditGrant con quién lo otorgó y en la bitácora.
// GET ?companyId=  devuelve gasto, extra y techo del mes.
export const dynamic = "force-dynamic";

const schema = z.object({
  companyId: z.string().min(1),
  usd: z.number().positive().max(500),
  nota: z.string().trim().max(300).optional(),
  periodo: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

async function operador() {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (!(await isOperador(session.user.id))) return null;
  return session.user;
}

export async function GET(req: Request) {
  const user = await operador();
  if (!user) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const estado = await estadoIAEmpresa(companyId);
  if (!estado) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  const grants = await prisma.aiCreditGrant.findMany({
    where: { companyId, periodo: estado.periodo },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ ...estado, grants });
}

export async function POST(req: Request) {
  const user = await operador();
  if (!user) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  const { companyId, usd, nota } = parsed.data;
  const periodo = parsed.data.periodo ?? periodoActualMx();

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, rfc: true } });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const grant = await prisma.aiCreditGrant.create({
    data: { companyId, periodo, usd, motivo: "cortesia", otorgadoPorUserId: user.id!, nota: nota ?? null },
  });
  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email ?? null,
    accion: "ia.credito-cortesia",
    entidad: "AiCreditGrant",
    entidadId: grant.id,
    detalle: { rfc: company.rfc, periodo, usd, nota: nota ?? null },
    req,
  });
  return NextResponse.json({ ok: true, grant, estado: await estadoIAEmpresa(companyId) });
}
