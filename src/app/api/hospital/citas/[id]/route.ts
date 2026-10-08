/**
 * PATCH /api/hospital/citas/[id] — estado, horario (con la misma regla de
 * empalmes), recurso, médico, episodio, notas y la hoja (anestesiólogo,
 * enfermera, instrumentista, diagnóstico, estancia, cama, insumos).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { citaCamposSchema, citaEmpalmada, datosHojaCita, describirEmpalme, incluyeCita, serializarCita, validarVinculosCita } from "@/lib/hospital/citas";

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = citaCamposSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const cita = await prisma.hospCita.findUnique({ where: { id }, include: { recurso: { select: { nombre: true } } } });
  if (!cita) throw new AuthzError(404, "Cita no encontrada");

  const { user } = await requireWriter(cita.companyId, req);
  await requireModule(cita.companyId, "HOSPITAL", req);

  const actualizada = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agenda:${cita.companyId}`}))`;
    const citaActual = await tx.hospCita.findUniqueOrThrow({ where: { id } });
  const inicio = d.inicio ? new Date(d.inicio) : citaActual.inicio;
  const fin = d.fin ? new Date(d.fin) : citaActual.fin;
  if (fin.getTime() <= inicio.getTime()) return error("La hora de fin debe ser posterior a la de inicio");

  const v = await validarVinculosCita(tx, citaActual.companyId, d);
  if (v.error != null) return error(v.error);

  const recursoId = d.recursoId ?? citaActual.recursoId;
  const estado = d.estado ?? citaActual.estado;
  const seMueve = d.recursoId !== undefined || d.inicio !== undefined || d.fin !== undefined || (d.estado !== undefined && d.estado !== citaActual.estado);
  if (seMueve && estado !== "CANCELADA" && estado !== "NO_ASISTIO") {
    const choque = await citaEmpalmada(tx, { recursoId, inicio, fin, excluirId: id });
    if (choque) return error(describirEmpalme(choque), 409);
  }

  return tx.hospCita.update({
    where: { id },
    data: {
      ...(d.recursoId ? { recursoId: d.recursoId } : {}),
      ...(d.tipo ? { tipo: d.tipo } : {}),
      ...(d.titulo ? { titulo: d.titulo.trim() } : {}),
      inicio,
      fin,
      estado,
      ...(d.pacienteId !== undefined ? { pacienteId: d.pacienteId, pacienteNombre: d.pacienteNombre?.trim() || v.pacienteNombre } : d.pacienteNombre !== undefined ? { pacienteNombre: d.pacienteNombre?.trim() || null } : {}),
      ...(d.medicoId !== undefined ? { medicoId: d.medicoId } : {}),
      ...(d.episodioId !== undefined ? { episodioId: d.episodioId } : {}),
      ...(d.cotizacionId !== undefined ? { cotizacionId: d.cotizacionId } : {}),
      ...(d.notas !== undefined ? { notas: d.notas?.trim() || null } : {}),
      ...datosHojaCita(d, citaActual),
    },
    include: incluyeCita,
  });

  });
  if (actualizada instanceof Response) return actualizada;

  bitacora(user, req, {
    companyId: cita.companyId,
    accion: "hospital.cita.editar",
    entidad: "HospCita",
    entidadId: id,
    detalle: { titulo: cita.titulo, cambios: Object.keys(d), estadoAntes: cita.estado, estadoDespues: actualizada.estado, recurso: actualizada.recurso.nombre },
  });
  return NextResponse.json(serializarCita(actualizada));
});
