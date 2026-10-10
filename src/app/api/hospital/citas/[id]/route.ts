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
import { resolverAltasCita, type AltaCita } from "@/lib/hospital/cita-altas";
import { citaCamposSchema, citaEmpalmada, datosHojaCita, describirEmpalme, incluyeCita, ocupaRecurso, serializarCita, validarVinculosCita } from "@/lib/hospital/citas";

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = citaCamposSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { pacienteNuevo, medicoNuevo, anestesiologoNuevo, ...d } = parsed.data;

  const cita = await prisma.hospCita.findUnique({ where: { id }, include: { recurso: { select: { nombre: true } } } });
  if (!cita) throw new AuthzError(404, "Cita no encontrada");

  const { user } = await requireWriter(cita.companyId, req);
  await requireModule(cita.companyId, "HOSPITAL", req);

  let altas: AltaCita[] = [];
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
  if (seMueve && ocupaRecurso(estado)) {
    const choque = await citaEmpalmada(tx, { recursoId, inicio, fin, excluirId: id });
    if (choque) return error(describirEmpalme(choque), 409);
  }

  const a = await resolverAltasCita(tx, citaActual.companyId, { ...d, pacienteNuevo, medicoNuevo, anestesiologoNuevo });
  if (a.error != null) return error(a.error);
  altas = a.altas;
  if (a.pacienteId) { d.pacienteId = a.pacienteId; d.pacienteNombre = a.altas.find((x) => x.rol === "PACIENTE")?.nombre ?? d.pacienteNombre; }
  if (a.medicoId) d.medicoId = a.medicoId;
  if (a.anestesiologoId) d.anestesiologoId = a.anestesiologoId;

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
      // Programar una solicitud fija la hora: deja de estar «por definir».
      horaPorDefinir: estado === "SOLICITADA" ? (d.horaPorDefinir ?? citaActual.horaPorDefinir) : false,
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
  for (const x of altas.filter((x) => x.nuevo)) {
    bitacora(user, req, {
      companyId: cita.companyId,
      accion: x.entidad === "HospPaciente" ? "hospital.paciente.crear" : "hospital.medico.crear",
      entidad: x.entidad,
      entidadId: x.id,
      detalle: { nombre: x.nombre, rol: x.rol, origen: "agenda", cita: id, ...(x.entidad === "HospMedico" ? { porCredencializar: true } : {}) },
    });
  }
  return NextResponse.json({ ...serializarCita(actualizada), altas });
});
