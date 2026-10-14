/**
 * GET  /api/hospital/solicitudes-area?companyId=[&vista=bandeja|mias|todas][&area=][&historico=1]
 *      Líneas que pidieron las áreas con su urgencia (la del área o la del
 *      inventario, la mayor), existencia, mínimo, días esperando y dónde van
 *      (bandeja, por autorizar, pedida, recibida, desabasto…).
 *      bandeja = sólo las que esperan a compras; mias = las que pidió el usuario.
 * POST /api/hospital/solicitudes-area { companyId, area, urgencia?, notas?,
 *                                      lineas: [{ hospInsumoId?, descripcion, unidad?, cantidad, urgencia?, motivo? }] }
 *      Un área pide sin proveedor; folio SA-AAAA-NNNN. Va a la bandeja de compras.
 *
 * Motor: lib/hospital/bandeja-compras.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearSolicitudArea, lineasArea, URGENCIAS } from "@/lib/hospital/bandeja-compras";
import { nombresDeUsuarios } from "@/lib/hospital/requisiciones-http";

const schema = z.object({
  companyId: z.string().min(1),
  area: z.string().trim().min(1, "Elige el área").max(80),
  urgencia: z.enum(URGENCIAS).nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
  lineas: z
    .array(
      z.object({
        hospInsumoId: z.string().min(1).nullable().optional(),
        descripcion: z.string().trim().min(1, "Escribe qué se necesita").max(300),
        unidad: z.string().trim().max(20).nullable().optional(),
        cantidad: z.number().positive("La cantidad debe ser mayor a cero").max(10_000_000),
        urgencia: z.enum(URGENCIAS).nullable().optional(),
        motivo: z.string().trim().max(500).nullable().optional(),
      })
    )
    .min(1, "Agrega al menos una línea")
    .max(200),
});

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const vista = sp.get("vista") ?? "bandeja";
  if (!["bandeja", "mias", "todas"].includes(vista)) return error("vista inválida");
  const lineas = await lineasArea(prisma, companyId, {
    soloBandeja: vista === "bandeja",
    solicitanteId: vista === "mias" ? user.id : undefined,
    area: sp.get("area") || undefined,
    historico: sp.get("historico") === "1",
  });
  return NextResponse.json({ usuarioId: user.id, lineas });
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const nombre = (await nombresDeUsuarios([user.id]))[user.id] ?? null;
  const r = await crearSolicitudArea(d.companyId, { id: user.id, nombre }, d);
  bitacora(user, req, { companyId: d.companyId, accion: "hospital.solicitudArea.crear", entidad: "HospSolicitudArea", entidadId: r.id, detalle: { folio: r.folio, area: d.area, lineas: r.lineas } });
  return NextResponse.json(r, { status: 201 });
});
