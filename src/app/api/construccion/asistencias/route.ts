/**
 * GET /api/construccion/asistencias?cuadrillaId=…&semana=YYYY-MM-DD
 *   La semana (lunes a domingo) de una cuadrilla: sus miembros con su
 *   trabajador, la asistencia capturada y la raya de esa semana si existe.
 *
 * PUT /api/construccion/asistencias
 *   { cuadrillaId, registros: [{ trabajadorId, fecha: "YYYY-MM-DD", horas, horasExtra? }] }
 *   Guarda (upsert) la asistencia; horas y extra en 0 borran el registro.
 *   Cada trabajador debe ser miembro activo de la cuadrilla. Una semana cuya
 *   raya ya se autorizó o pagó queda CERRADA: su asistencia no se toca, así
 *   lo autorizado no cambia por debajo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { fechaDia, isoDia, rangoSemana } from "@/lib/construccion/raya-calculo";

const trabajadorSel = {
  select: { id: true, nombre: true, tipoPago: true, tarifa: true, horasJornada: true, especialidad: true },
} as const;

async function cargarCuadrilla(id: string) {
  const c = await prisma.cuadrilla.findUnique({
    where: { id },
    select: { id: true, companyId: true, proyectoId: true, nombre: true },
  });
  if (!c) throw new AuthzError(404, "Cuadrilla no encontrada");
  return c;
}

/** Raya de la cuadrilla cuya semana empieza en `desde` (tolera hora local). */
function rayaDeSemana(cuadrillaId: string, desde: Date) {
  const fin = new Date(desde);
  fin.setUTCDate(fin.getUTCDate() + 1);
  return prisma.rayaSemanal.findFirst({
    where: { cuadrillaId, semanaInicio: { gte: desde, lt: fin } },
    select: { id: true, estado: true, total: true },
  });
}

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const cuadrillaId = url.searchParams.get("cuadrillaId");
  const semana = url.searchParams.get("semana");
  if (!cuadrillaId || !semana) {
    return NextResponse.json({ error: "cuadrillaId y semana requeridos" }, { status: 400 });
  }
  const c = await cargarCuadrilla(cuadrillaId);
  await requireMembership(c.companyId, undefined, req);
  await requireModule(c.companyId, "CONSTRUCCION");

  let desde: Date, hasta: Date;
  try {
    ({ desde, hasta } = rangoSemana(fechaDia(semana)));
  } catch {
    return NextResponse.json({ error: "semana inválida (YYYY-MM-DD)" }, { status: 400 });
  }

  const [miembros, asistencias, raya] = await Promise.all([
    prisma.cuadrillaMiembro.findMany({
      where: { cuadrillaId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, nombre: true, rolEnCuadrilla: true, trabajador: trabajadorSel },
    }),
    prisma.asistencia.findMany({
      where: { cuadrillaId, fecha: { gte: desde, lt: hasta } },
      select: { trabajadorId: true, fecha: true, horas: true, horasExtra: true },
    }),
    rayaDeSemana(cuadrillaId, desde),
  ]);

  const dias = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(desde);
    d.setUTCDate(d.getUTCDate() + i);
    return isoDia(d);
  });

  return NextResponse.json({
    cuadrilla: c,
    dias,
    miembros,
    asistencias: asistencias.map((a) => ({
      trabajadorId: a.trabajadorId,
      fecha: isoDia(a.fecha),
      horas: Number(a.horas),
      horasExtra: Number(a.horasExtra),
    })),
    raya,
    cerrada: !!raya && raya.estado !== "BORRADOR",
  });
});

const putSchema = z.object({
  cuadrillaId: z.string().min(1),
  registros: z
    .array(
      z.object({
        trabajadorId: z.string().min(1),
        fecha: z.string(),
        horas: z.number().min(0).max(24),
        horasExtra: z.number().min(0).max(24).optional(),
      })
    )
    .min(1)
    .max(500),
});

export const PUT = withAuthz(async (req: Request) => {
  const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { cuadrillaId, registros } = parsed.data;
  const c = await cargarCuadrilla(cuadrillaId);
  const { user } = await requireWriter(c.companyId, req);
  await requireModule(c.companyId, "CONSTRUCCION");

  // Cada trabajador debe ser miembro activo de la cuadrilla.
  const miembros = await prisma.cuadrillaMiembro.findMany({
    where: { cuadrillaId, isActive: true, trabajadorId: { not: null } },
    select: { trabajadorId: true },
  });
  const validos = new Set(miembros.map((m) => m.trabajadorId));
  const ajenos = registros.filter((r) => !validos.has(r.trabajadorId));
  if (ajenos.length) {
    return NextResponse.json(
      { error: "Hay trabajadores que no son miembros de esta cuadrilla" },
      { status: 400 }
    );
  }

  let fechas: Date[];
  try {
    fechas = registros.map((r) => fechaDia(r.fecha));
  } catch {
    return NextResponse.json({ error: "fecha inválida (YYYY-MM-DD)" }, { status: 400 });
  }

  // Semanas cerradas (raya autorizada o pagada) no se tocan.
  const lunes = [...new Set(fechas.map((f) => isoDia(rangoSemana(f).desde)))];
  for (const l of lunes) {
    const raya = await rayaDeSemana(cuadrillaId, fechaDia(l));
    if (raya && raya.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `La semana del ${l} ya tiene su raya ${raya.estado.toLowerCase()}; su asistencia está cerrada` },
        { status: 409 }
      );
    }
  }

  await prisma.$transaction(
    registros.map((r, i) => {
      const where = {
        trabajadorId_proyectoId_fecha: {
          trabajadorId: r.trabajadorId,
          proyectoId: c.proyectoId,
          fecha: fechas[i],
        },
      };
      const horasExtra = r.horasExtra ?? 0;
      if (r.horas === 0 && horasExtra === 0) {
        return prisma.asistencia.deleteMany({
          where: { trabajadorId: r.trabajadorId, proyectoId: c.proyectoId, fecha: fechas[i] },
        });
      }
      return prisma.asistencia.upsert({
        where,
        create: {
          companyId: c.companyId,
          trabajadorId: r.trabajadorId,
          proyectoId: c.proyectoId,
          cuadrillaId,
          fecha: fechas[i],
          horas: r.horas,
          horasExtra,
          capturadaPorId: user.id,
        },
        update: { horas: r.horas, horasExtra, cuadrillaId, capturadaPorId: user.id },
      });
    })
  );

  return NextResponse.json({ ok: true, guardados: registros.length });
});
