/**
 * GET    /api/hospital/requisiciones/[id]   Detalle: líneas (con la solicitud de área que atienden y su ganadora),
 *                                            cotizaciones a comparar (precio por línea), historial y sus
 *                                            órdenes (una por proveedor ganador, con pedido, recepción y pago).
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
import { existenciaPorInsumo } from "@/lib/hospital/bandeja-compras";
import { aRequisicionInput, nombresDeUsuarios, requisicionSchema } from "@/lib/hospital/requisiciones-http";

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
      supplier: { select: { id: true, razonSocial: true, rfc: true, email: true, terms: { select: { tieneCredito: true, diasCredito: true } } } },
      partidas: {
        select: {
          id: true, descripcion: true, unidad: true, cantidad: true, precioUnitario: true, importe: true, cantidadRecibida: true,
          hospInsumo: { select: { id: true, clave: true, nombre: true, unidad: true, minimo: true, maximo: true } },
          cotizacionGanadoraId: true,
          hospLineaArea: { select: { id: true, urgencia: true, intentos: true, proveedorSugeridoNombre: true, solicitud: { select: { folio: true, area: true, solicitanteNombre: true } } } },
        },
        orderBy: { id: "asc" },
      },
      cotizaciones: {
        select: {
          id: true, supplierId: true, supplierNombre: true, tieneCredito: true, diasCredito: true, diasEntrega: true, vigenciaHasta: true,
          notas: true, total: true, isSelected: true,
          partidas: { select: { solicitudPartidaId: true, precioUnitario: true, importe: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const insumoIds = [...new Set(r.partidas.map((p) => p.hospInsumo?.id).filter((x): x is string => !!x))];
  const existencias = await existenciaPorInsumo(prisma, companyId, insumoIds);
  const ordenes = await ordenesDeCompra(prisma, companyId, { solicitudId: id });
  const nombres = await nombresDeUsuarios([r.creadaPorId, r.aprobadaPorId, r.rechazadaPorId, ...ordenes.flatMap((o) => [o.autorizacionPago?.porId, o.pedido?.porId])]);
  const emails = new Map(
    (await prisma.supplier.findMany({ where: { id: { in: r.cotizaciones.map((c) => c.supplierId).filter((x): x is string => !!x) } }, select: { id: true, email: true, rfc: true } })).map((x) => [x.id, x])
  );
  return NextResponse.json({
    usuarioId: user.id,
    ...r,
    total: Number(r.total),
    partidas: r.partidas.map((p) => ({
      ...p,
      // Inventario del insumo para decidir cuánto pedir: existencia, mínimo y máximo.
      hospInsumo: p.hospInsumo ? { ...p.hospInsumo, minimo: Number(p.hospInsumo.minimo), maximo: p.hospInsumo.maximo == null ? null : Number(p.hospInsumo.maximo), existencia: existencias.get(p.hospInsumo.id) ?? 0 } : null,
      cantidad: Number(p.cantidad), precioUnitario: Number(p.precioUnitario), importe: Number(p.importe), cantidadRecibida: Number(p.cantidadRecibida) })),
    // La comparación: cada cotización con su precio por partida (null = no la cotizó).
    cotizaciones: r.cotizaciones.map((c) => {
      const precio = new Map(c.partidas.map((x) => [x.solicitudPartidaId, Number(x.precioUnitario)]));
      return {
        id: c.id, supplierId: c.supplierId, supplierNombre: c.supplierNombre, rfc: c.supplierId ? emails.get(c.supplierId)?.rfc ?? null : null,
        email: c.supplierId ? emails.get(c.supplierId)?.email ?? null : null,
        tieneCredito: c.tieneCredito, diasCredito: c.diasCredito, diasEntrega: c.diasEntrega, vigenciaHasta: c.vigenciaHasta, notas: c.notas,
        total: Number(c.total), gana: c.isSelected,
        precios: r.partidas.map((p) => precio.get(p.id) ?? null),
      };
    }),
    creadaPor: r.creadaPorId ? nombres[r.creadaPorId] ?? null : null,
    aprobadaPor: r.aprobadaPorId ? nombres[r.aprobadaPorId] ?? null : null,
    rechazadaPor: r.rechazadaPorId ? nombres[r.rechazadaPorId] ?? null : null,
    ordenes: ordenes.map((o) => ({
      ...o,
      pagoAutorizadoPor: o.autorizacionPago?.porId ? nombres[o.autorizacionPago.porId] ?? null : null,
      pedidoEnviadoPor: o.pedido?.porId ? nombres[o.pedido.porId] ?? null : null,
    })),
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
  const r = await editarRequisicion(id, companyId, aRequisicionInput(d));
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
