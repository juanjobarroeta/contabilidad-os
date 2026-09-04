/**
 * GET /api/hospital/censo?companyId=…[&area=HOSPITALIZACION]
 *
 * «Quién está en qué cama, y desde cuándo» (lámina 14): KPIs del día (sobre
 * TODAS las camas, no sólo el área filtrada), las camas con su episodio y los
 * movimientos de cama del día (HospTraslado).
 */

import { NextResponse } from "next/server";
import type { HospArea } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { diaDeEstancia, kpisCenso } from "@/lib/hospital/censo";
import { claveDia, finDiaLocal, horaLocal, inicioDiaLocal, sumarDias } from "@/lib/hospital/tz";
import { ESTADOS_ACTIVOS, nombreCompleto } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const area = searchParams.get("area") as HospArea | null;
  const hoy = new Date();
  const inicio = inicioDiaLocal(hoy);
  const fin = finDiaLocal(hoy);

  const [camas, ingresos, altas, recientes, traslados] = await Promise.all([
    prisma.hospRecurso.findMany({
      where: { companyId, tipo: "CAMA", activo: true },
      include: {
        servicio: { select: { id: true, nombre: true, precioLista: true } },
        episodios: {
          where: { estado: { in: ESTADOS_ACTIVOS } },
          take: 1,
          orderBy: { fechaIngreso: "desc" },
          include: {
            paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, fechaNacimiento: true } },
            medico: { select: { id: true, nombre: true, especialidad: true } },
          },
        },
      },
      orderBy: [{ orden: "asc" }, { nombre: "asc" }],
    }),
    prisma.hospEpisodio.findMany({
      where: { companyId, estado: { not: "CANCELADO" }, fechaIngreso: { gte: inicio, lt: fin } },
      select: { fechaIngreso: true },
    }),
    prisma.hospEpisodio.findMany({ where: { companyId, estado: "ALTA", fechaAlta: { gte: inicio, lt: fin } }, select: { fechaAlta: true } }),
    // Estancia promedio: hospitalizaciones que hoy ocupan cama + altas de los últimos 30 días.
    prisma.hospEpisodio.findMany({
      where: {
        companyId,
        tipo: "HOSPITALIZACION",
        OR: [{ estado: { in: ESTADOS_ACTIVOS }, recursoId: { not: null } }, { estado: "ALTA", fechaAlta: { gte: sumarDias(inicio, -30) } }],
      },
      select: { fechaIngreso: true, fechaAlta: true },
    }),
    prisma.hospTraslado.findMany({
      where: { fecha: { gte: inicio, lt: fin }, episodio: { companyId } },
      include: {
        episodio: {
          select: { id: true, folio: true, estado: true, paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } } },
        },
      },
      orderBy: { fecha: "asc" },
    }),
  ]);

  const filas = camas.map((c) => {
    const ep = c.episodios[0] ?? null;
    return {
      id: c.id,
      nombre: c.nombre,
      area: c.area,
      estado: c.estado,
      orden: c.orden,
      servicio: c.servicio ? { id: c.servicio.id, nombre: c.servicio.nombre, precioLista: Number(c.servicio.precioLista) } : null,
      episodio: ep
        ? {
            id: ep.id,
            folio: ep.folio,
            paciente: nombreCompleto(ep.paciente),
            pacienteId: ep.paciente.id,
            dia: diaDeEstancia(ep.fechaIngreso, hoy),
            fechaIngreso: ep.fechaIngreso,
            medico: ep.medico?.nombre ?? null,
            medicoId: ep.medico?.id ?? null,
            estado: ep.estado,
            tipo: ep.tipo,
          }
        : null,
    };
  });

  const kpis = kpisCenso({ camas: filas.map((f) => ({ estado: f.estado, episodio: f.episodio ? { fechaIngreso: f.episodio.fechaIngreso } : null })), ingresos, altas, estancias: recientes, hoy });

  return NextResponse.json({
    fecha: claveDia(hoy),
    kpis: { ocupadas: kpis.ocupadas, camas: kpis.camas, pct: kpis.pct, ingresosHoy: kpis.ingresosHoy, altasHoy: kpis.altasHoy, estanciaPromedio: kpis.estanciaPromedio },
    areas: [...new Set(camas.map((c) => c.area))],
    camas: area ? filas.filter((f) => f.area === area) : filas,
    movimientos: traslados.map((t) => ({
      id: t.id,
      fecha: t.fecha,
      hora: horaLocal(t.fecha),
      tipo: t.tipo,
      paciente: nombreCompleto(t.episodio.paciente),
      folio: t.episodio.folio,
      episodioId: t.episodio.id,
      de: t.deRecursoNombre,
      a: t.aRecursoNombre,
      nota: t.nota,
    })),
  });
});
