/**
 * GET    /api/hospital/protocolos/[id]
 * PATCH  /api/hospital/protocolos/[id]   { …campos…, partidas?, insumos? } — sube `version`; partidas/insumos presentes REEMPLAZAN la lista
 * DELETE /api/hospital/protocolos/[id]   → activo:false (los planes que ya nacieron de él no se tocan)
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import {
  armarInsumosProtocolo,
  armarPartidasProtocolo,
  incluyeProtocolo,
  protocoloPatchSchema,
  resolverCiesProtocolo,
  serializarProtocolo,
} from "@/lib/hospital/protocolo";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const p = await prisma.hospProtocolo.findUnique({ where: { id }, include: incluyeProtocolo });
  if (!p) throw new AuthzError(404, "Protocolo no encontrado");

  await requireMembership(p.companyId, undefined, req);
  await requireModule(p.companyId, "HOSPITAL", req);

  return NextResponse.json(serializarProtocolo(p));
});

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = protocoloPatchSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { partidas: partidasEntrada, insumos: insumosEntrada, procedimientoCie9, diagnosticoCie10, ...d } = parsed.data;

  const p = await prisma.hospProtocolo.findUnique({ where: { id }, select: { id: true, companyId: true, clave: true, version: true } });
  if (!p) throw new AuthzError(404, "Protocolo no encontrado");

  const { user } = await requireWriter(p.companyId, req);
  await requireModule(p.companyId, "HOSPITAL", req);

  const clave = d.clave?.trim().toUpperCase();
  if (clave && clave !== p.clave) {
    const repetido = await prisma.hospProtocolo.findUnique({ where: { companyId_clave: { companyId: p.companyId, clave } }, select: { id: true } });
    if (repetido) return error(`Ya existe un protocolo con la clave ${clave}`, 409);
  }
  const cies = await resolverCiesProtocolo(prisma, { procedimientoCie9, diagnosticoCie10 });
  const partidas = partidasEntrada !== undefined ? await armarPartidasProtocolo(prisma, p.companyId, partidasEntrada) : null;
  const insumos = insumosEntrada !== undefined ? await armarInsumosProtocolo(prisma, p.companyId, insumosEntrada) : null;

  const actualizado = await prisma.$transaction(async (tx) => {
    if (partidas) await tx.hospProtocoloPartida.deleteMany({ where: { protocoloId: id } });
    if (insumos) await tx.hospProtocoloInsumo.deleteMany({ where: { protocoloId: id } });
    return tx.hospProtocolo.update({
      where: { id },
      data: {
        ...(clave ? { clave } : {}),
        ...(d.nombre !== undefined ? { nombre: d.nombre.trim() } : {}),
        ...(d.descripcion !== undefined ? { descripcion: d.descripcion?.trim() || null } : {}),
        ...(d.tipoEpisodio !== undefined ? { tipoEpisodio: d.tipoEpisodio } : {}),
        ...cies,
        ...(d.especialidad !== undefined ? { especialidad: d.especialidad?.trim() || null } : {}),
        ...(d.estanciaNoches !== undefined ? { estanciaNoches: d.estanciaNoches } : {}),
        ...(d.quirofanoMinutos !== undefined ? { quirofanoMinutos: d.quirofanoMinutos } : {}),
        ...(d.tipoAnestesia !== undefined ? { tipoAnestesia: d.tipoAnestesia } : {}),
        ...(d.requiereAnestesiologo !== undefined ? { requiereAnestesiologo: d.requiereAnestesiologo } : {}),
        ...(d.honorarioCirujano !== undefined ? { honorarioCirujano: d.honorarioCirujano } : {}),
        ...(d.honorarioAnestesiologo !== undefined ? { honorarioAnestesiologo: d.honorarioAnestesiologo } : {}),
        ...(d.activo !== undefined ? { activo: d.activo } : {}),
        ...(partidas ? { partidas: { create: partidas } } : {}),
        ...(insumos ? { insumos: { create: insumos } } : {}),
        version: { increment: 1 },
      },
      include: incluyeProtocolo,
    });
  });

  bitacora(user, req, {
    companyId: p.companyId,
    accion: "hospital.protocolo.editar",
    entidad: "HospProtocolo",
    entidadId: id,
    detalle: { clave: actualizado.clave, version: actualizado.version, cambios: Object.keys(parsed.data) },
  });
  return NextResponse.json(serializarProtocolo(actualizado));
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const p = await prisma.hospProtocolo.findUnique({ where: { id }, select: { id: true, companyId: true, clave: true, activo: true } });
  if (!p) throw new AuthzError(404, "Protocolo no encontrado");

  const { user } = await requireWriter(p.companyId, req);
  await requireModule(p.companyId, "HOSPITAL", req);

  const actualizado = await prisma.hospProtocolo.update({ where: { id }, data: { activo: false }, include: incluyeProtocolo });
  if (p.activo) {
    bitacora(user, req, { companyId: p.companyId, accion: "hospital.protocolo.baja", entidad: "HospProtocolo", entidadId: id, detalle: { clave: p.clave } });
  }
  return NextResponse.json(serializarProtocolo(actualizado));
});
