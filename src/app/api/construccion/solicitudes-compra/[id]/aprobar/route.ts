import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { generateAdjudicaciones } from "@/lib/construccion/adjudicaciones";

// POST /api/construccion/solicitudes-compra/:id/aprobar
export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const solicitud = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!solicitud) {
      throw new AuthzError(404, "Solicitud no encontrada");
    }

    const { user } = await requireWriter(solicitud.companyId, req);
    await requireModule(solicitud.companyId, "CONSTRUCCION");

    if (solicitud.estado !== "PENDIENTE") {
      return NextResponse.json(
        { error: `No se puede aprobar una solicitud en estado ${solicitud.estado}` },
        { status: 422 }
      );
    }

    // Approve + fan the awarded lines out into one payable per supplier so
    // tesorería can pay each separately. Atomic so we never approve without
    // the payables (or vice-versa).
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.solicitudCompra.update({
        where: { id },
        data: {
          estado: "APROBADA",
          aprobadaPorId: user.id,
          aprobadaAt: new Date(),
        },
      });
      await generateAdjudicaciones(tx, id);
      return u;
    });

    return NextResponse.json(updated);
  }
);
