import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// PATCH /api/hallazgos/[id]
//   body { estado: "ABIERTO" | "RESUELTO" | "IGNORADO" }  → cambia el ciclo de vida
//   body { posponer: "7d" | "30d" | "fin_de_mes" }        → silencia (snooze) hasta esa fecha
// La decisión sobrevive a las re-corridas del auditor (el upsert preserva estado y
// posponerHasta). Cambiar `estado` limpia el snooze; reabrir (ABIERTO) lo reactiva.

const ESTADOS = ["ABIERTO", "RESUELTO", "IGNORADO"] as const;
const DIAS: Record<string, number> = { "7d": 7, "30d": 30 };

function calcPosponerHasta(token: string): Date | null {
  const now = new Date();
  if (token === "fin_de_mes") return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const dias = DIAS[token];
  if (dias) {
    const d = new Date(now);
    d.setDate(d.getDate() + dias);
    return d;
  }
  return null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Resolver la acción: posponer (snooze) o cambio de estado.
  let data: { estado?: string; posponerHasta: Date | null };
  if (typeof body?.posponer === "string") {
    const hasta = calcPosponerHasta(body.posponer);
    if (!hasta) return NextResponse.json({ error: "posponer inválido" }, { status: 400 });
    data = { estado: "ABIERTO", posponerHasta: hasta };
  } else if ((ESTADOS as readonly string[]).includes(body?.estado)) {
    // Cualquier cambio de estado limpia el snooze (reabrir = reactivar).
    data = { estado: body.estado, posponerHasta: null };
  } else {
    return NextResponse.json({ error: "acción inválida" }, { status: 400 });
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
    data,
    select: { id: true, estado: true, posponerHasta: true, updatedAt: true },
  });

  return NextResponse.json({
    ok: true,
    hallazgo: {
      id: updated.id,
      estado: updated.estado,
      posponerHasta: updated.posponerHasta?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}
