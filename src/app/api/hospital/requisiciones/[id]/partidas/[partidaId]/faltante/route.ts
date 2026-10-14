/**
 * POST /api/hospital/requisiciones/[id]/partidas/[partidaId]/faltante { accion: REENVIAR|DESABASTO, motivo? }
 *
 * El proveedor no surtió todo de esta línea. La línea se cierra en lo
 * recibido (la orden se paga por lo que llegó) y lo que faltó regresa a la
 * bandeja de compras para pedirlo a otro proveedor (REENVIAR) o se cierra por
 * desabasto. Si la orden queda en cero, la requisición se cancela.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { companyDeRequisicion } from "@/lib/hospital/requisiciones";
import { cerrarFaltante } from "@/lib/hospital/bandeja-compras";

type Ctx = { params: Promise<{ id: string; partidaId: string }> };
const schema = z
  .object({ accion: z.enum(["REENVIAR", "DESABASTO"]), motivo: z.string().trim().max(500).optional().default("") })
  .refine((d) => d.accion !== "DESABASTO" || d.motivo.length >= 3, { message: "Escribe por qué no se consigue", path: ["motivo"] });

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, partidaId } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await cerrarFaltante(partidaId, companyId, user.id, parsed.data.accion, parsed.data.motivo);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.faltante", entidad: "SolicitudPartida", entidadId: partidaId, detalle: { requisicionId: id, ...r } });
  return NextResponse.json({ ok: true, ...r });
});
