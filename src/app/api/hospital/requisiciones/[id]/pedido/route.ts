/**
 * POST /api/hospital/requisiciones/[id]/pedido { via: WHATSAPP|CORREO|TELEFONO|OTRO }
 *
 * Registra que el pedido de una requisición autorizada se mandó al proveedor
 * (el mensaje sale del teléfono o correo de quien compra). Se puede volver a
 * marcar: queda la última vez.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { companyDeRequisicion } from "@/lib/hospital/requisiciones";
import { marcarPedidoEnviado, VIAS_PEDIDO } from "@/lib/hospital/bandeja-compras";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ via: z.enum(VIAS_PEDIDO) });

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await marcarPedidoEnviado(id, companyId, user.id, parsed.data.via);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.pedido", entidad: "SolicitudCompra", entidadId: id, detalle: { via: r.via } });
  return NextResponse.json({ ok: true, ...r });
});
