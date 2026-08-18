import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH  /api/facturas/recurrentes/[id] — pausar / reanudar / cambiar el fin.
// DELETE /api/facturas/recurrentes/[id] — borrar la serie.
//
// Borrar una serie NO toca las prefacturas que ya generó: son documentos
// aparte, y quien cancela una suscripción no quiere que desaparezcan los
// borradores del mes que ya estaba revisando.
// ─────────────────────────────────────────────────────────────────────────────

const patchSchema = z.object({
  companyId: z.string().min(1),
  activa: z.boolean().optional(),
  fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/** Carga la serie comprobando que sea de la empresa que dice el cuerpo. */
async function serieDeLaEmpresa(id: string, companyId: string) {
  return prisma.facturaRecurrente.findFirst({
    where: { id, companyId },
    select: { id: true, nombre: true, activa: true },
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const d = parsed.data;
    const { user } = await requireWriter(d.companyId, req);
    await assertPuedeEscribir(user.id);

    const serie = await serieDeLaEmpresa(id, d.companyId);
    if (!serie) return NextResponse.json({ error: "Serie no encontrada" }, { status: 404 });

    const actualizada = await prisma.facturaRecurrente.update({
      where: { id },
      data: {
        ...(d.activa != null ? { activa: d.activa } : {}),
        ...(d.fin !== undefined
          ? { fin: d.fin ? new Date(`${d.fin}T00:00:00.000Z`) : null }
          : {}),
      },
      select: { id: true, activa: true, fin: true, proximaEmision: true },
    });

    registrarBitacora({
      companyId: d.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: d.activa === false ? "factura.recurrente.pausar" : "factura.recurrente.actualizar",
      entidad: "FacturaRecurrente",
      entidadId: id,
      detalle: { nombre: serie.nombre, activa: actualizada.activa },
      req,
    });

    return NextResponse.json({ ok: true, serie: actualizada });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    const { user } = await requireWriter(companyId, req);
    await assertPuedeEscribir(user.id);

    const serie = await serieDeLaEmpresa(id, companyId);
    if (!serie) return NextResponse.json({ error: "Serie no encontrada" }, { status: 404 });

    await prisma.facturaRecurrente.delete({ where: { id } });

    registrarBitacora({
      companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.recurrente.eliminar",
      entidad: "FacturaRecurrente",
      entidadId: id,
      detalle: { nombre: serie.nombre },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
