import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, usuarioDe } from "@/lib/hospital/http";
import { HospitalError } from "@/lib/hospital/errores";
import { cerrarConteo, detalleConteo } from "@/lib/hospital/conteo-db";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/hospital/farmacia/conteos/[id]?companyId=   → líneas y diferencias
// POST /api/hospital/farmacia/conteos/[id]  { companyId, accion: "cerrar" | "cancelar", faltantesEnCero? }
//   cerrar: un AJUSTE del kardex por cada diferencia (y su asiento si la
//   contabilidad del hospital está activa). cancelar: sin movimientos.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json({ conteo: await detalleConteo(prisma, companyId, id) });
});

const schema = z.object({
  companyId: z.string().min(1),
  accion: z.enum(["cerrar", "cancelar"]),
  faltantesEnCero: z.boolean().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, accion } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  const u = usuarioDe(user);
  if (accion === "cancelar") {
    const r = await prisma.hospConteo.updateMany({ where: { id, companyId, estado: "ABIERTO" }, data: { estado: "CANCELADO", cerradoAt: new Date(), cerradoPorNombre: u.nombre } });
    if (r.count !== 1) throw new HospitalError(409, "El conteo no está abierto");
    bitacora(user, req, { companyId, accion: "hospital.conteo.cancelar", entidad: "HospConteo", entidadId: id, detalle: {} });
    return NextResponse.json({ ok: true });
  }
  const r = await cerrarConteo(prisma, { companyId, conteoId: id, faltantesEnCero: parsed.data.faltantesEnCero ?? false, usuarioId: u.id, usuarioNombre: u.nombre });
  bitacora(user, req, { companyId, accion: "hospital.conteo.cerrar", entidad: "HospConteo", entidadId: id, detalle: { ajustes: r.ajustes.length, faltantesEnCero: parsed.data.faltantesEnCero ?? false } });
  return NextResponse.json({ ok: true, ajustes: r.ajustes, conteo: await detalleConteo(prisma, companyId, id) });
});
