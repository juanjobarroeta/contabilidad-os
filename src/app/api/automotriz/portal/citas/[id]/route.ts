import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, withAuthz } from "@/lib/authz";
import { requireAutoPortalAccount } from "@/lib/automotriz/portal";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/automotriz/portal/citas/[id] — el cliente cancela SU cita.
// Cancelación suave (estado CANCELADA, canceladaPor CLIENTE); sólo citas
// abiertas y futuras — una cita ya recibida es una orden, y eso no se cancela
// desde el portal.
// ─────────────────────────────────────────────────────────────────────────────

export const DELETE = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const portal = await requireAutoPortalAccount(req);
  const { id } = await ctx.params;

  const cita = await prisma.citaServicio.findUnique({
    where: { id },
    select: { companyId: true, customerId: true, estado: true, fecha: true },
  });
  if (!cita || cita.companyId !== portal.companyId || cita.customerId !== portal.customerId) {
    throw new AuthzError(404, "Cita no encontrada");
  }
  if (cita.estado !== "PENDIENTE" && cita.estado !== "CONFIRMADA") {
    return NextResponse.json({ error: `Una cita ${cita.estado} ya no se cancela` }, { status: 422 });
  }
  if (cita.fecha <= new Date()) {
    return NextResponse.json({ error: "La cita ya pasó; contacta al taller" }, { status: 422 });
  }

  const updated = await prisma.citaServicio.update({
    where: { id },
    data: { estado: "CANCELADA", canceladaAt: new Date(), canceladaPor: "CLIENTE" },
    select: { id: true, estado: true },
  });
  registrarBitacora({
    companyId: portal.companyId,
    actorEmail: portal.email,
    accion: "automotriz.portal.cita.cancelar",
    entidad: "CitaServicio",
    entidadId: id,
  });
  return NextResponse.json(updated);
});
