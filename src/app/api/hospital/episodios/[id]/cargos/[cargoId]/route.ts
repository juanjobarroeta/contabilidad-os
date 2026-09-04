/**
 * DELETE /api/hospital/episodios/[id]/cargos/[cargoId]  { motivo }
 *
 * Cancela (no borra): el renglón queda con `cancelado` y su motivo. Si el
 * cargo salió de farmacia, el lote recupera la existencia con un movimiento
 * DEVOLUCION. 409 si el cargo ya está en un CFDI. El motivo puede venir en el
 * body JSON o en ?motivo= (algunos clientes no mandan body en DELETE).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, usuarioDe } from "@/lib/hospital/http";
import { cancelarCargo } from "@/lib/hospital/cargos";

const schema = z.object({ motivo: z.string().min(1).max(500) });

export const DELETE = withHospital(async (req: Request, ctx: { params: Promise<{ id: string; cargoId: string }> }) => {
  const { id, cargoId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? { motivo: new URL(req.url).searchParams.get("motivo") ?? "" });
  if (!parsed.success) return error("motivo requerido");

  const cargo = await prisma.hospCargo.findUnique({
    where: { id: cargoId },
    select: { id: true, episodioId: true, companyId: true, descripcion: true, importe: true, origen: true, episodio: { select: { folio: true } } },
  });
  if (!cargo || cargo.episodioId !== id) throw new AuthzError(404, "Cargo no encontrado");

  const { user } = await requireWriter(cargo.companyId, req);
  await requireModule(cargo.companyId, "HOSPITAL", req);

  const resultado = await prisma.$transaction((tx) => cancelarCargo(tx, cargoId, { motivo: parsed.data.motivo.trim(), usuario: usuarioDe(user) }));

  bitacora(user, req, {
    companyId: cargo.companyId,
    accion: "hospital.cargo.cancelar",
    entidad: "HospCargo",
    entidadId: cargoId,
    detalle: {
      folio: cargo.episodio.folio,
      descripcion: cargo.descripcion,
      importe: Number(cargo.importe),
      origen: cargo.origen,
      motivo: parsed.data.motivo,
      devolucion: resultado.devolucion,
    },
  });

  return NextResponse.json({ cargo: resultado.cargo, devolucion: resultado.devolucion });
});
