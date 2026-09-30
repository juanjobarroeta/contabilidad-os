/**
 * POST /api/hospital/ordenes/[id]/recibir { partidaId, cantidad }
 *
 * Recepción de una línea que NO es insumo de farmacia (servicio, equipo,
 * papelería). Los insumos se reciben con su lote en Farmacia
 * (/farmacia/lotes con solicitudPartidaId) para que entren al inventario.
 * No se recibe de más: lo extra es otra requisición.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { companyDeOrden, recibirManual } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ partidaId: z.string().min(1), cantidad: z.number().positive().max(10_000_000) });

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeOrden(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await recibirManual(parsed.data.partidaId, companyId, parsed.data.cantidad);
  bitacora(user, req, { companyId, accion: "hospital.orden.recibir", entidad: "SolicitudPartida", entidadId: parsed.data.partidaId, detalle: { ordenId: id, cantidad: parsed.data.cantidad } });
  return NextResponse.json({ ok: true, ...r });
});
