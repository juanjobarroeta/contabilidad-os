/**
 * GET  /api/hospital/citas?companyId=…&desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&recursoId=&medicoId=]
 * POST /api/hospital/citas — 409 si empalma con otra cita viva del recurso.
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
import { citaCamposSchema, citaEmpalmada, describirEmpalme, incluyeCita, serializarCita, validarVinculosCita } from "@/lib/hospital/citas";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const rango = rangoDeQuery(searchParams.get("desde"), searchParams.get("hasta"));
  if (!rango || rango.hasta <= rango.desde) return error("Rango de fechas inválido (desde, hasta)");
  const recursoId = searchParams.get("recursoId");
  const medicoId = searchParams.get("medicoId");

  const [recursos, citas] = await Promise.all([
    prisma.hospRecurso.findMany({
      where: { companyId, activo: true, tipo: { in: ["QUIROFANO", "CONSULTORIO", "SALA"] } },
      select: { id: true, tipo: true, area: true, nombre: true, estado: true, orden: true },
      orderBy: [{ tipo: "asc" }, { orden: "asc" }, { nombre: "asc" }],
    }),
    prisma.hospCita.findMany({
      where: {
        companyId,
        inicio: { lt: rango.hasta },
        fin: { gt: rango.desde },
        ...(recursoId ? { recursoId } : {}),
        ...(medicoId ? { medicoId } : {}),
      },
      include: incluyeCita,
      orderBy: { inicio: "asc" },
      take: 1000,
    }),
  ]);

  return NextResponse.json({ desde: rango.desde, hasta: rango.hasta, recursos, citas: citas.map(serializarCita) });
});

const createSchema = citaCamposSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const cita = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agenda:${companyId}`}))`;
  const inicio = new Date(d.inicio);
  const fin = new Date(d.fin);
  if (fin.getTime() <= inicio.getTime()) return error("La hora de fin debe ser posterior a la de inicio");

  const v = await validarVinculosCita(tx, companyId, d);
  if (v.error != null) return error(v.error);

  const estado = d.estado ?? "PROGRAMADA";
  if (estado !== "CANCELADA" && estado !== "NO_ASISTIO") {
    const choque = await citaEmpalmada(tx, { recursoId: d.recursoId, inicio, fin });
    if (choque) return error(describirEmpalme(choque), 409);
  }

  return tx.hospCita.create({
    data: {
      companyId,
      recursoId: d.recursoId,
      tipo: d.tipo,
      titulo: d.titulo.trim(),
      inicio,
      fin,
      estado,
      pacienteId: d.pacienteId ?? null,
      pacienteNombre: d.pacienteNombre?.trim() || v.pacienteNombre,
      medicoId: d.medicoId ?? null,
      episodioId: d.episodioId ?? null,
      cotizacionId: d.cotizacionId ?? null,
      notas: d.notas?.trim() || null,
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
  return NextResponse.json(serializarCita(cita), { status: 201 });
});
