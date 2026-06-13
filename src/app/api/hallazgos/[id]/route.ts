import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// PATCH /api/hallazgos/[id]  body: { estado: "ABIERTO" | "RESUELTO" | "IGNORADO" }
// Cambia el ciclo de vida de un hallazgo. La decisión sobrevive a las re-corridas
// del auditor (upsert preserva `estado`). RESOLVER/IGNORAR un hallazgo 69-B
// definitivo reactiva las deducciones de ese proveedor en el motor de impuestos.

const ESTADOS = ["ABIERTO", "RESUELTO", "IGNORADO"] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const estado = body?.estado;
  if (!(ESTADOS as readonly string[]).includes(estado)) {
    return NextResponse.json({ error: "estado inválido" }, { status: 400 });
  }

  const hallazgo = await prisma.fiscalHallazgo.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!hallazgo) return NextResponse.json({ error: "Hallazgo no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, hallazgo.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const updated = await prisma.fiscalHallazgo.update({
    where: { id },
    data: { estado },
    select: { id: true, estado: true, updatedAt: true },
  });

  return NextResponse.json({
    ok: true,
    hallazgo: { id: updated.id, estado: updated.estado, updatedAt: updated.updatedAt.toISOString() },
  });
}
