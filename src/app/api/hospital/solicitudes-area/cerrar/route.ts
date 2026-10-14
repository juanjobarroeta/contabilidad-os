/**
 * POST /api/hospital/solicitudes-area/cerrar { companyId, lineaIds, cierre: DESABASTO|CANCELADA, motivo }
 *
 * Compras cierra líneas que esperan en la bandeja (o cuya requisición se
 * rechazó): desabasto = no se consigue; cancelada = ya no se necesita.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { cerrarLineas } from "@/lib/hospital/bandeja-compras";

const schema = z.object({
  companyId: z.string().min(1),
  lineaIds: z.array(z.string().min(1)).min(1).max(500),
  cierre: z.enum(["DESABASTO", "CANCELADA"]),
  motivo: z.string().trim().min(3, "Escribe el motivo").max(500),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await cerrarLineas(d.companyId, user.id, d.lineaIds, d.cierre, d.motivo);
  bitacora(user, req, { companyId: d.companyId, accion: "hospital.solicitudArea.cerrar", entidad: "HospSolicitudAreaLinea", entidadId: d.lineaIds[0], detalle: { cierre: d.cierre, motivo: d.motivo, lineas: d.lineaIds } });
  return NextResponse.json({ ok: true, ...r });
});
