/**
 * GET  /api/hospital/servicios?companyId=…[&categoria=&todos=1]
 * POST /api/hospital/servicios
 *
 * Tarifario: precio de lista + precio por pagador (HospTarifa). El IVA por
 * default sale de la categoría: honorarios exentos, farmacia 0 %, lo demás
 * con `HospConfig.ivaServicios` (0.16).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospCargoCategoria } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { ivaDefault } from "@/lib/hospital/util";
import { serializarServicio, servicioSchema } from "@/lib/hospital/servicio-schema";

const incluye = { tarifas: { include: { pagador: { select: { id: true, nombre: true, tipo: true } } }, orderBy: { pagador: { nombre: "asc" as const } } } };

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const categoria = searchParams.get("categoria") as HospCargoCategoria | null;
  const todos = searchParams.get("todos") === "1";
  const servicios = await prisma.hospServicio.findMany({
    where: { companyId, ...(categoria ? { categoria } : {}), ...(todos ? {} : { activo: true }) },
    include: incluye,
    orderBy: [{ categoria: "asc" }, { nombre: "asc" }],
  });
  return NextResponse.json(servicios.map(serializarServicio));
});

const createSchema = servicioSchema.extend({
  companyId: z.string().min(1),
  tarifas: z.array(z.object({ pagadorId: z.string().min(1), precio: z.number().min(0) })).max(200).optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, tarifas, ivaTasa, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const clave = d.clave.trim().toUpperCase();
  const dup = await prisma.hospServicio.findUnique({ where: { companyId_clave: { companyId, clave } }, select: { id: true } });
  if (dup) return error(`Ya existe un servicio con clave ${clave}`, 409);

  if (tarifas?.length) {
    const pagadores = await prisma.hospPagador.count({ where: { companyId, id: { in: tarifas.map((t) => t.pagadorId) } } });
    if (pagadores !== new Set(tarifas.map((t) => t.pagadorId)).size) return error("Algún pagadorId de las tarifas no es de esta empresa");
  }

  const config = await prisma.hospConfig.findUnique({ where: { companyId }, select: { ivaServicios: true } });
  const servicio = await prisma.hospServicio.create({
    data: {
      companyId,
      ...d,
      clave,
      nombre: d.nombre.trim(),
      ivaTasa: ivaTasa !== undefined ? ivaTasa : ivaDefault(d.categoria, config ? Number(config.ivaServicios) : null),
      ...(tarifas?.length ? { tarifas: { create: tarifas.map((t) => ({ pagadorId: t.pagadorId, precio: t.precio })) } } : {}),
    },
    include: incluye,
  });
  bitacora(user, req, { companyId, accion: "hospital.servicio.crear", entidad: "HospServicio", entidadId: servicio.id, detalle: { clave, nombre: servicio.nombre, categoria: d.categoria, precioLista: d.precioLista } });
  return NextResponse.json(serializarServicio(servicio), { status: 201 });
});
