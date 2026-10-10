/**
 * GET  /api/hospital/citas?companyId=…&desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&recursoId=&medicoId=&estado=]
 * POST /api/hospital/citas — 409 si empalma con otra cita viva del recurso.
 *      Lo agendado nace CONFIRMADO (salvo solicitudes). `pacienteNuevo`,
 *      `medicoNuevo` y `anestesiologoNuevo` dan de alta lo que se escribió
 *      libre (lib/hospital/cita-altas.ts) en la misma transacción.
 *
 * `desde`/`hasta` a secas son días locales completos (hasta inclusivo); sin
 * ellos, hoy. Responde los recursos agendables (quirófanos, consultorios,
 * salas) y las citas que tocan la ventana.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, rangoDeQuery } from "@/lib/hospital/http";
import { resolverAltasCita, type AltaCita } from "@/lib/hospital/cita-altas";
import { CITA_ESTADOS, citaCamposSchema, citaEmpalmada, datosHojaCita, describirEmpalme, incluyeCita, ocupaRecurso, puedeProgramarAgenda, serializarCita, validarVinculosCita } from "@/lib/hospital/citas";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  const { user, membership } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const rango = rangoDeQuery(searchParams.get("desde"), searchParams.get("hasta"));
  if (!rango || rango.hasta <= rango.desde) return error("Rango de fechas inválido (desde, hasta)");
  const recursoId = searchParams.get("recursoId");
  const medicoId = searchParams.get("medicoId");
  const estadoQ = searchParams.get("estado");
  const estado = (CITA_ESTADOS as readonly string[]).includes(estadoQ ?? "") ? (estadoQ as (typeof CITA_ESTADOS)[number]) : null;

  const [recursos, citas, miembro] = await Promise.all([
    prisma.hospRecurso.findMany({
      where: { companyId, activo: true, tipo: { in: ["QUIROFANO", "CONSULTORIO", "SALA"] } },
      select: { id: true, tipo: true, area: true, nombre: true, estado: true, orden: true, minutosLimpieza: true },
      orderBy: [{ tipo: "asc" }, { orden: "asc" }, { nombre: "asc" }],
    }),
    prisma.hospCita.findMany({
      where: {
        companyId,
        inicio: { lt: rango.hasta },
        fin: { gt: rango.desde },
        ...(recursoId ? { recursoId } : {}),
        ...(medicoId ? { medicoId } : {}),
        ...(estado ? { estado } : {}),
      },
      include: incluyeCita,
      orderBy: { inicio: "asc" },
      take: 1000,
    }),
    prisma.companyMember.findUnique({ where: { userId_companyId: { userId: user.id, companyId } }, select: { hospitalPermisos: true } }),
  ]);

  return NextResponse.json({
    desde: rango.desde,
    hasta: rango.hasta,
    recursos,
    citas: citas.map(serializarCita),
    // La pantalla esconde «Agendar» y los botones de estado a quien sólo consulta.
    acciones: { puedeProgramar: puedeProgramarAgenda(membership.role, miembro?.hospitalPermisos) },
  });
});

const createSchema = citaCamposSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, pacienteNuevo, medicoNuevo, anestesiologoNuevo, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  let altas: AltaCita[] = [];
  const cita = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agenda:${companyId}`}))`;
  const inicio = new Date(d.inicio);
  const fin = new Date(d.fin);
  if (fin.getTime() <= inicio.getTime()) return error("La hora de fin debe ser posterior a la de inicio");

  const v = await validarVinculosCita(tx, companyId, d);
  if (v.error != null) return error(v.error);

  const estado = d.estado ?? "CONFIRMADA";
  if (ocupaRecurso(estado)) {
    const choque = await citaEmpalmada(tx, { recursoId: d.recursoId, inicio, fin });
    if (choque) return error(describirEmpalme(choque), 409);
  }

  // Después del empalme: una cita rechazada no deja altas huérfanas.
  const a = await resolverAltasCita(tx, companyId, { ...d, pacienteNuevo, medicoNuevo, anestesiologoNuevo });
  if (a.error != null) return error(a.error);
  altas = a.altas;
  const altaPaciente = a.altas.find((x) => x.rol === "PACIENTE");

  return tx.hospCita.create({
    data: {
      companyId,
      recursoId: d.recursoId,
      tipo: d.tipo,
      titulo: d.titulo.trim(),
      inicio,
      fin,
      estado,
      pacienteId: d.pacienteId ?? a.pacienteId ?? null,
      pacienteNombre: d.pacienteNombre?.trim() || v.pacienteNombre || altaPaciente?.nombre || null,
      medicoId: d.medicoId ?? a.medicoId ?? null,
      episodioId: d.episodioId ?? null,
      cotizacionId: d.cotizacionId ?? null,
      notas: d.notas?.trim() || null,
      ...datosHojaCita({ ...d, ...(a.anestesiologoId ? { anestesiologoId: a.anestesiologoId } : {}) }),
      horaPorDefinir: estado === "SOLICITADA" && d.horaPorDefinir === true,
    },
    include: incluyeCita,
  });

  });
  if (cita instanceof Response) return cita;

  bitacora(user, req, {
    companyId,
    accion: "hospital.cita.crear",
    entidad: "HospCita",
    entidadId: cita.id,
    detalle: { recurso: d.recursoId, titulo: cita.titulo, inicio: cita.inicio.toISOString(), fin: cita.fin.toISOString(), estado: cita.estado },
  });
  for (const x of altas.filter((x) => x.nuevo)) {
    bitacora(user, req, {
      companyId,
      accion: x.entidad === "HospPaciente" ? "hospital.paciente.crear" : "hospital.medico.crear",
      entidad: x.entidad,
      entidadId: x.id,
      detalle: { nombre: x.nombre, rol: x.rol, origen: "agenda", cita: cita.id, ...(x.entidad === "HospMedico" ? { porCredencializar: true } : {}) },
    });
  }
  return NextResponse.json({ ...serializarCita(cita), altas }, { status: 201 });
});
