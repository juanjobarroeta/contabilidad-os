/**
 * GET    /api/hospital/requisiciones/[id]   Detalle: líneas, proveedor, historial y su orden (si ya se autorizó).
 * PUT    /api/hospital/requisiciones/[id]   Reescribe una requisición por autorizar o rechazada (vuelve a «por autorizar»).
 * DELETE /api/hospital/requisiciones/[id]   Cancela (nunca borra). Autorizada, sólo si su orden no tiene recepción, factura ni pagos.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { cancelarRequisicion, companyDeRequisicion, editarRequisicion, ordenesDeCompra } from "@/lib/hospital/requisiciones";
import { nombresDeUsuarios, requisicionSchema } from "@/lib/hospital/requisiciones-http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const r = await prisma.solicitudCompra.findUniqueOrThrow({
    where: { id },
    select: {
      id: true, folio: true, estado: true, area: true, notas: true, total: true, formaPago: true, fechaEntrega: true, createdAt: true,
      creadaPorId: true, aprobadaPorId: true, aprobadaAt: true, rechazadaPorId: true, rechazadaAt: true, rechazoMotivo: true,
      supplier: { select: { id: true, razonSocial: true, rfc: true, terms: { select: { tieneCredito: true, diasCredito: true } } } },
      partidas: {
        select: {
          id: true, descripcion: true, unidad: true, cantidad: true, precioUnitario: true, importe: true, cantidadRecibida: true,
          hospInsumo: { select: { id: true, clave: true, nombre: true, unidad: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  const [orden] = await ordenesDeCompra(prisma, companyId, { solicitudId: id });
  const nombres = await nombresDeUsuarios([r.creadaPorId, r.aprobadaPorId, r.rechazadaPorId, orden?.autorizacionPago?.porId]);
  return NextResponse.json({
    usuarioId: user.id,
    ...r,
    total: Number(r.total),
    partidas: r.partidas.map((p) => ({ ...p, cantidad: Number(p.cantidad), precioUnitario: Number(p.precioUnitario), importe: Number(p.importe), cantidadRecibida: Number(p.cantidadRecibida) })),
    creadaPor: r.creadaPorId ? nombres[r.creadaPorId] ?? null : null,
    aprobadaPor: r.aprobadaPorId ? nombres[r.aprobadaPorId] ?? null : null,
    rechazadaPor: r.rechazadaPorId ? nombres[r.rechazadaPorId] ?? null : null,
    orden: orden ? { ...orden, pagoAutorizadoPor: orden.autorizacionPago?.porId ? nombres[orden.autorizacionPago.porId] ?? null : null } : null,
  });
});

export const PUT = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = await companyDeRequisicion(id);
  const parsed = requisicionSchema.safeParse({ ...((await req.json().catch(() => null)) ?? {}), companyId });
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const d = parsed.data;
  const r = await editarRequisicion(id, companyId, { ...d, fechaEntrega: d.fechaEntrega ? new Date(d.fechaEntrega) : null });
  bitacora(user, req, { companyId, accion: "hospital.requisicion.editar", entidad: "SolicitudCompra", entidadId: id, detalle: { folio: r.folio, total: r.total } });
  return NextResponse.json(r);
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await cancelarRequisicion(id, companyId);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.cancelar", entidad: "SolicitudCompra", entidadId: id, detalle: { folio: r.folio } });
  return NextResponse.json({ ok: true, ...r });
});
