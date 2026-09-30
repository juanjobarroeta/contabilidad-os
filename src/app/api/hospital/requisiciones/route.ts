/**
 * GET  /api/hospital/requisiciones?companyId=[&estado=PENDIENTE|APROBADA|RECHAZADA|CANCELADA|PAGADA][&mias=1]
 *      Requisiciones del hospital, más recientes primero, con proveedor,
 *      total, quién pidió / autorizó / rechazó y la etapa de su orden.
 * POST /api/hospital/requisiciones { companyId, supplierId, area?, notas?, fechaEntrega?,
 *                                    partidas: [{ hospInsumoId?, descripcion, unidad?, cantidad, precioUnitario }] }
 *      Nace «por autorizar» (toda compra requiere autorización) con folio
 *      REQ-AAAA-NNNN. Motor: lib/hospital/requisiciones.ts.
 *
 * Puerta del hospital: página requisiciones · compras · tesorería.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearRequisicion, ordenesDeCompra, ORIGEN_HOSPITAL } from "@/lib/hospital/requisiciones";
import { nombresDeUsuarios, requisicionSchema } from "@/lib/hospital/requisiciones-http";

const ESTADOS = ["BORRADOR", "PENDIENTE", "APROBADA", "RECHAZADA", "PAGADA", "CANCELADA"] as const;

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const estado = sp.get("estado");
  if (estado && !(ESTADOS as readonly string[]).includes(estado)) return error("estado inválido");

  const rows = await prisma.solicitudCompra.findMany({
    where: {
      companyId,
      origen: ORIGEN_HOSPITAL,
      ...(estado ? { estado: estado as (typeof ESTADOS)[number] } : {}),
      ...(sp.get("mias") === "1" ? { creadaPorId: user.id } : {}),
    },
    select: {
      id: true, folio: true, estado: true, area: true, notas: true, total: true, formaPago: true, fechaEntrega: true, createdAt: true,
      creadaPorId: true, aprobadaPorId: true, aprobadaAt: true, rechazadaPorId: true, rechazadaAt: true, rechazoMotivo: true,
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { partidas: true } },
      adjudicaciones: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const ordenes = await ordenesDeCompra(prisma, companyId, {});
  const etapaDe = new Map(ordenes.map((o) => [o.solicitudId, { ordenId: o.id, etapa: o.etapa, saldo: o.pago.saldo }]));
  const nombres = await nombresDeUsuarios(rows.flatMap((r) => [r.creadaPorId, r.aprobadaPorId, r.rechazadaPorId]));
  return NextResponse.json({
    usuarioId: user.id,
    requisiciones: rows.map(({ _count, adjudicaciones: _a, total, ...r }) => ({
      ...r,
      total: Number(total),
      lineas: _count.partidas,
      creadaPor: r.creadaPorId ? nombres[r.creadaPorId] ?? null : null,
      aprobadaPor: r.aprobadaPorId ? nombres[r.aprobadaPorId] ?? null : null,
      rechazadaPor: r.rechazadaPorId ? nombres[r.rechazadaPorId] ?? null : null,
      orden: etapaDe.get(r.id) ?? null,
    })),
  });
});

export const POST = withHospital(async (req: Request) => {
  const parsed = requisicionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await crearRequisicion(d.companyId, user.id, { ...d, fechaEntrega: d.fechaEntrega ? new Date(d.fechaEntrega) : null });
  bitacora(user, req, { companyId: d.companyId, accion: "hospital.requisicion.crear", entidad: "SolicitudCompra", entidadId: r.id, detalle: { folio: r.folio, total: r.total, supplierId: d.supplierId } });
  return NextResponse.json(r, { status: 201 });
});
