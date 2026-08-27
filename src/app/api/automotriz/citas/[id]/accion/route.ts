import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/citas/[id]/accion — transiciones de la agenda:
//   confirmar (PENDIENTE → CONFIRMADA)
//   cancelar  (PENDIENTE/CONFIRMADA → CANCELADA, canceladaPor STAFF)
//   no_show   (PENDIENTE/CONFIRMADA con fecha pasada → NO_SHOW)
// Recibir (cita → orden) tiene su propia ruta: [id]/recibir.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({ accion: z.enum(["confirmar", "cancelar", "no_show"]) });

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { accion } = parsed.data;

  const cita = await prisma.citaServicio.findUnique({
    where: { id },
    select: { companyId: true, estado: true, fecha: true },
  });
  if (!cita) throw new AuthzError(404, "Cita no encontrada");
  const { user } = await requireWriter(cita.companyId, req);
  await requireModule(cita.companyId, "AUTOMOTRIZ", req);

  let data: { estado: "CONFIRMADA" | "CANCELADA" | "NO_SHOW" } & Record<string, unknown>;
  if (accion === "confirmar") {
    if (cita.estado !== "PENDIENTE") {
      return NextResponse.json({ error: `Sólo una cita PENDIENTE se confirma (${cita.estado})` }, { status: 422 });
    }
    data = { estado: "CONFIRMADA", confirmadaAt: new Date() };
  } else if (accion === "cancelar") {
    if (cita.estado !== "PENDIENTE" && cita.estado !== "CONFIRMADA") {
      return NextResponse.json({ error: `Una cita ${cita.estado} ya no se cancela` }, { status: 422 });
    }
    data = { estado: "CANCELADA", canceladaAt: new Date(), canceladaPor: "STAFF" };
  } else {
    if (cita.estado !== "PENDIENTE" && cita.estado !== "CONFIRMADA") {
      return NextResponse.json({ error: `Una cita ${cita.estado} no puede ser no-show` }, { status: 422 });
    }
    if (cita.fecha > new Date()) {
      return NextResponse.json({ error: "Una cita futura todavía no es no-show" }, { status: 422 });
    }
    data = { estado: "NO_SHOW" };
  }

  const updated = await prisma.citaServicio.update({ where: { id }, data });
  registrarBitacora({
    companyId: cita.companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: `automotriz.cita.${accion}`,
    entidad: "CitaServicio",
    entidadId: id,
  });
  return NextResponse.json(updated);
});
