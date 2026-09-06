/**
 * GET  /api/hospital/protocolos?companyId=…[&q=&activo=1|0]
 * POST /api/hospital/protocolos { companyId, clave, nombre, tipoEpisodio, procedimientoCie9?, diagnosticoCie10?, …, partidas, insumos }
 *
 * El protocolo es la receta reutilizable de un procedimiento (partidas del
 * tarifario sin precio, insumos, estancia, quirófano, anestesia, honorarios
 * sugeridos). `usos` = planes de tratamiento que nacieron de él.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import {
  armarInsumosProtocolo,
  armarPartidasProtocolo,
  incluyeProtocolo,
  protocoloCamposSchema,
  resolverCiesProtocolo,
  serializarProtocolo,
} from "@/lib/hospital/protocolo";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const q = searchParams.get("q")?.trim();
  const activo = searchParams.get("activo");
  const where: Prisma.HospProtocoloWhereInput = {
    companyId,
    ...(activo === "1" || activo === "true" ? { activo: true } : activo === "0" || activo === "false" ? { activo: false } : {}),
    ...(q
      ? {
          OR: [
            { clave: { contains: q, mode: "insensitive" } },
            { nombre: { contains: q, mode: "insensitive" } },
            { especialidad: { contains: q, mode: "insensitive" } },
            { procedimientoCie9: { contains: q, mode: "insensitive" } },
            { diagnosticoCie10: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const protocolos = await prisma.hospProtocolo.findMany({
    where,
    include: incluyeProtocolo,
    orderBy: [{ activo: "desc" }, { nombre: "asc" }],
    take: 500,
  });
  return NextResponse.json(protocolos.map(serializarProtocolo));
});

const createSchema = protocoloCamposSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, partidas: partidasEntrada, insumos: insumosEntrada, procedimientoCie9, diagnosticoCie10, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const clave = d.clave.trim().toUpperCase();
  const repetido = await prisma.hospProtocolo.findUnique({ where: { companyId_clave: { companyId, clave } }, select: { id: true } });
  if (repetido) return error(`Ya existe un protocolo con la clave ${clave}`, 409);

  const cies = await resolverCiesProtocolo(prisma, { procedimientoCie9: procedimientoCie9 ?? null, diagnosticoCie10: diagnosticoCie10 ?? null });
  const partidas = await armarPartidasProtocolo(prisma, companyId, partidasEntrada);
  const insumos = await armarInsumosProtocolo(prisma, companyId, insumosEntrada);

  const protocolo = await prisma.hospProtocolo.create({
    data: {
      companyId,
      clave,
      nombre: d.nombre.trim(),
      descripcion: d.descripcion?.trim() || null,
      tipoEpisodio: d.tipoEpisodio,
      procedimientoCie9: cies.procedimientoCie9 ?? null,
      diagnosticoCie10: cies.diagnosticoCie10 ?? null,
      especialidad: d.especialidad?.trim() || null,
      estanciaNoches: d.estanciaNoches,
      quirofanoMinutos: d.quirofanoMinutos ?? null,
      tipoAnestesia: d.tipoAnestesia ?? null,
      requiereAnestesiologo: d.requiereAnestesiologo,
      honorarioCirujano: d.honorarioCirujano ?? null,
      honorarioAnestesiologo: d.honorarioAnestesiologo ?? null,
      activo: d.activo ?? true,
      partidas: { create: partidas },
      insumos: { create: insumos },
    },
    include: incluyeProtocolo,
  });

  bitacora(user, req, {
    companyId,
    accion: "hospital.protocolo.crear",
    entidad: "HospProtocolo",
    entidadId: protocolo.id,
    detalle: { clave, nombre: protocolo.nombre, partidas: partidas.length, insumos: insumos.length },
  });
  return NextResponse.json(serializarProtocolo(protocolo), { status: 201 });
});
