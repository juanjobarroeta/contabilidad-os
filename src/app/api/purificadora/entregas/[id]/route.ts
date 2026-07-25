import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancelar") }),
  z.object({ action: z.literal("reactivar") }),
]);

// PATCH /api/purificadora/entregas/[id] — mismas reglas que los tickets:
//   cancelar   ← cualquier writer, sólo REGISTRADAS (error de captura en ruta)
//   reactivar  ← sólo OWNER/ADMIN, sólo si el corte del día no está confirmado
// Sin efecto contable: las entregas sólo postean al integrarse al corte.
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const entrega = await prisma.purifEntrega.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true, fecha: true, importe: true, tipo: true },
  });
  if (!entrega) throw new AuthzError(404, "Entrega no encontrada");

  await requireModule(entrega.companyId, "PURIFICADORA", req);

  switch (parsed.data.action) {
    case "cancelar": {
      const { user: actor } = await requireWriter(entrega.companyId, req);
      if (entrega.estado !== "REGISTRADO") {
        return NextResponse.json(
          { error: `Sólo se cancelan entregas REGISTRADAS (estado actual: ${entrega.estado})` },
          { status: 422 }
        );
      }
      const updated = await prisma.purifEntrega.update({
        where: { id },
        data: { estado: "CANCELADO" },
      });
      registrarBitacora({
        companyId: entrega.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "entrega.cancelar",
        entidad: "PurifEntrega",
        entidadId: entrega.id,
        detalle: {
          tipo: entrega.tipo,
          importe: entrega.importe,
          fecha: entrega.fecha.toISOString().slice(0, 10),
        },
      });
      return NextResponse.json(updated);
    }

    case "reactivar": {
      const { user: actor } = await requireMembership(entrega.companyId, ["OWNER", "ADMIN"], req);
      if (entrega.estado !== "CANCELADO") {
        return NextResponse.json(
          { error: `Sólo se reactivan entregas CANCELADAS (estado actual: ${entrega.estado})` },
          { status: 422 }
        );
      }
      const corte = await prisma.purifCorte.findUnique({
        where: { companyId_fecha: { companyId: entrega.companyId, fecha: entrega.fecha } },
        select: { estado: true },
      });
      if (corte?.estado === "CONFIRMADO") {
        return NextResponse.json(
          {
            error:
              "El corte de ese día ya está confirmado — la entrega ya no puede integrarse. Captura la venta directamente en Ventas.",
          },
          { status: 422 }
        );
      }
      const updated = await prisma.purifEntrega.update({
        where: { id },
        data: { estado: "REGISTRADO" },
      });
      registrarBitacora({
        companyId: entrega.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "entrega.reactivar",
        entidad: "PurifEntrega",
        entidadId: entrega.id,
        detalle: {
          tipo: entrega.tipo,
          importe: entrega.importe,
          fecha: entrega.fecha.toISOString().slice(0, 10),
        },
      });
      return NextResponse.json(updated);
    }
  }
});
