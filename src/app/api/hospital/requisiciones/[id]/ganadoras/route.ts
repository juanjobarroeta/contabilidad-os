/**
 * PUT /api/hospital/requisiciones/[id]/ganadoras { ganadoras: { [partidaId]: cotizacionId } }
 *
 * Mientras está por autorizar, cambia qué proveedor gana cada línea (la
 * partida toma su precio). Lo hace compras al recomendar o quien autoriza al
 * comparar; la autorización también lo acepta en el mismo paso.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { HospitalError } from "@/lib/hospital/errores";
import { companyDeRequisicion, reasignarGanadoras } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ ganadoras: z.record(z.string().min(1), z.string().min(1)) });

export const PUT = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await prisma.$transaction(async (tx) => {
    // Condicionado al estado: una autorización simultánea no se mueve debajo.
    const n = await tx.solicitudCompra.updateMany({ where: { id, estado: "PENDIENTE" }, data: { updatedAt: new Date() } });
    if (n.count !== 1) throw new HospitalError(409, "Sólo se cambia la ganadora de una requisición por autorizar");
    await reasignarGanadoras(tx, id, parsed.data.ganadoras);
  });
  bitacora(user, req, { companyId, accion: "hospital.requisicion.ganadoras", entidad: "SolicitudCompra", entidadId: id, detalle: { ganadoras: parsed.data.ganadoras } });
  return NextResponse.json({ ok: true });
});
