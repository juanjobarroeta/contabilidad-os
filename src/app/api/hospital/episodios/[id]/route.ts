/**
 * GET   /api/hospital/episodios/[id] — el expediente completo (lámina 6).
 *       Registra el acceso (LECTURA_EXPEDIENTE; `?acceso=IMPRESION|EXPORTACION`
 *       cuando el satélite imprime o exporta) sin bloquear la respuesta.
 * PATCH /api/hospital/episodios/[id] — { action: "estado"|"traslado"|"alta"|"datos"|"cancelar"|"seguimiento", … }
 *
 * Todo cambio de estado clínico o de cama queda en bitácora y en
 * HospTraslado; las noches de estancia se aseguran al leer y antes de soltar
 * la cama en el alta (después ya no hay cama de la cual cobrarlas).
 *
 * P1: el alta exige motivo de egreso y CIE-10 de egreso; en cirugía
 * ambulatoria, Aldrete ≥ 9 (NOM-026) salvo defunción/traslado/fuga/alta
 * voluntaria; la nota de egreso nace con secciones y firma del médico
 * tratante. `seguimiento` registra la llamada posterior al alta.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospAccesoAccion, HospEpisodioEstado } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { asegurarCargosEstancia } from "@/lib/hospital/estancia";
import { diaDeEstancia } from "@/lib/hospital/censo";
import { nombresCie, resolverCie } from "@/lib/hospital/cie";
import { describirRecursoNoLibre, validarTriage } from "@/lib/hospital/episodio";
import { crearNota, normalizarAsa, verificarHashNota } from "@/lib/hospital/notas";
import { customerResumen, medicoResumen, pacienteResumen, pagadorResumen, recursoResumen, totalesCargos } from "@/lib/hospital/serializar";
import { esActivo, r2 } from "@/lib/hospital/util";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const base = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, pacienteId: true } });
  if (!base) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireMembership(base.companyId, undefined, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  const accesoParam = new URL(req.url).searchParams.get("acceso")?.toUpperCase();
  const accion: HospAccesoAccion = accesoParam === "IMPRESION" || accesoParam === "EXPORTACION" ? accesoParam : "LECTURA_EXPEDIENTE";
  registrarAcceso({ companyId: base.companyId, accion, episodioId: base.id, pacienteId: base.pacienteId, detalle: `Expediente ${base.folio}`, user, req });

  const hoy = new Date();
  await asegurarCargosEstancia(prisma, id, hoy);

  const e = await prisma.hospEpisodio.findUniqueOrThrow({
    where: { id },
    include: {
      paciente: { include: { pagador: { select: { id: true, nombre: true, tipo: true } }, customer: { select: { id: true, razonSocial: true, rfc: true } } } },
      recurso: true,
      medico: true,
      pagador: true,
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      cotizacion: { select: { id: true, folio: true, estado: true, total: true } },
      signos: { orderBy: { fecha: "desc" }, take: 50 },
      notas: {
        orderBy: { fecha: "desc" },
        include: {
          medico: { select: { id: true, nombre: true, especialidad: true } },
          reemplazadaPor: { select: { id: true } },
          cargo: { select: { id: true, descripcion: true, importe: true, cancelado: true } },
        },
      },
      // Sin los bytes del archivo: se descargan por …/documentos/[docId]/archivo.
      documentos: { orderBy: { createdAt: "asc" }, omit: { archivo: true } },
      cargos: { select: { categoria: true, importe: true, ivaTasa: true, cancelado: true } },
      citas: {
        orderBy: { inicio: "asc" },
        include: { recurso: { select: { id: true, nombre: true, tipo: true } }, medico: { select: { id: true, nombre: true } } },
      },
      traslados: { orderBy: { fecha: "asc" } },
    },
  });

  const { paciente, recurso, medico, pagador, customer, cotizacion, signos, notas, documentos, cargos, citas, traslados, ...datos } = e;

  const porCategoria: Record<string, number> = {};
  for (const c of cargos) {
    if (c.cancelado) continue;
    const importe = Number(c.importe);
    const total = r2(importe + (c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa))));
    porCategoria[c.categoria] = r2((porCategoria[c.categoria] ?? 0) + total);
  }
  const totales = totalesCargos(cargos);
  const cie = await nombresCie(prisma, e);

  // Reloj de cirugía ambulatoria (NOM-026): cuánto falta para las 12 h.
  const ambulatorio =
    e.tipo === "AMBULATORIO" && e.limiteAmbulatorioAt
      ? {
          limiteAt: e.limiteAmbulatorioAt,
          minutosRestantes: Math.round((e.limiteAmbulatorioAt.getTime() - (e.fechaAlta ?? hoy).getTime()) / 60_000),
          vencido: (e.fechaAlta ?? hoy).getTime() > e.limiteAmbulatorioAt.getTime(),
        }
      : null;

  return NextResponse.json({
    ...datos,
    paciente: {
      ...paciente,
      ...pacienteResumen(paciente, hoy),
      pagador: paciente.pagador,
      customer: customerResumen(paciente.customer),
    },
    recurso: recursoResumen(recurso),
    medico: medicoResumen(medico),
    pagador: pagadorResumen(pagador),
    customer: customerResumen(customer),
    cotizacion: cotizacion ? { ...cotizacion, total: Number(cotizacion.total) } : null,
    cie,
    ambulatorio,
    diaEstancia: diaDeEstancia(e.fechaIngreso, e.fechaAlta ?? hoy),
    ultimosSignos: signos[0] ?? null,
    signos,
    notas: notas.map(({ reemplazadaPor, ...n }) => ({ ...n, reemplazadaPor: reemplazadaPor?.id ?? null, hashVerificado: verificarHashNota(n) })),
    documentos,
    pendientes: documentos.filter((d) => d.requerido && d.estado === "PENDIENTE"),
    cargos: { ...totales, porCategoria, conteo: cargos.filter((c) => !c.cancelado).length },
    citas,
    traslados,
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────

const ESTADOS = ["PROGRAMADO", "EN_VALORACION", "PREOPERATORIO", "EN_QUIROFANO", "POSTOPERATORIO", "HOSPITALIZADO", "ALTA", "CANCELADO"] as const;
const MOTIVOS_EGRESO = ["CURACION", "MEJORIA", "TRASLADO", "DEFUNCION", "VOLUNTARIA", "FUGA", "OTRO"] as const;
/** Egresos en los que no aplica el criterio de recuperación anestésica. */
const EGRESOS_SIN_ALDRETE = new Set<string>(["DEFUNCION", "TRASLADO", "FUGA", "VOLUNTARIA"]);
const ALDRETE_MINIMO = 9;

/** Transiciones clínicas permitidas por `action: "estado"`. ALTA y CANCELADO tienen su acción. */
const TRANSICIONES: Record<HospEpisodioEstado, HospEpisodioEstado[]> = {
  PROGRAMADO: ["EN_VALORACION", "PREOPERATORIO", "HOSPITALIZADO"],
  EN_VALORACION: ["PREOPERATORIO", "HOSPITALIZADO"],
  PREOPERATORIO: ["EN_QUIROFANO"],
  EN_QUIROFANO: ["POSTOPERATORIO"],
  POSTOPERATORIO: ["HOSPITALIZADO"],
  // Un hospitalizado puede volver a quirófano (segundo tiempo quirúrgico).
  HOSPITALIZADO: ["PREOPERATORIO"],
  ALTA: [],
  CANCELADO: [],
};

const datosSchema = z.object({
  medicoId: z.string().nullable().optional(),
  pagadorId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  diagnosticoCie10: z.string().max(10).nullable().optional(),
  diagnostico: z.string().max(300).nullable().optional(),
  procedimiento: z.string().max(300).nullable().optional(),
  motivo: z.string().max(1000).nullable().optional(),
  autorizacionPagador: z.string().max(80).nullable().optional(),
  notasAdmin: z.string().max(4000).nullable().optional(),
  diagnosticoIngresoCie10: z.string().max(10).nullable().optional(),
  procedimientoCie9: z.string().max(10).nullable().optional(),
  triageNivel: z.number().int().min(1).max(5).nullable().optional(),
  triageAt: fechaSchema.nullable().optional(),
  asa: z.string().max(5).nullable().optional(),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("estado"), estado: z.enum(ESTADOS), nota: z.string().max(500).nullable().optional() }),
  z.object({ action: z.literal("traslado"), recursoId: z.string().min(1), nota: z.string().max(500).nullable().optional() }),
  z.object({
    action: z.literal("alta"),
    motivoEgreso: z.enum(MOTIVOS_EGRESO),
    diagnosticoEgresoCie10: z.string().min(1).max(10),
    procedimientoCie9: z.string().max(10).nullable().optional(),
    aldreteEgreso: z.number().int().min(0).max(10).nullable().optional(),
    fechaAlta: fechaSchema.nullable().optional(),
    nota: z.string().max(4000).nullable().optional(),
    /** Plan de manejo e instrucciones de egreso: van en la nota de egreso (NOM-004 §8.10). */
    instrucciones: z.string().max(8000).nullable().optional(),
  }),
  datosSchema.extend({ action: z.literal("datos") }),
  z.object({ action: z.literal("cancelar"), motivo: z.string().min(1).max(500) }),
  z.object({ action: z.literal("seguimiento"), seguimientoAt: fechaSchema.nullable().optional(), seguimientoNota: z.string().min(1).max(4000) }),
]);

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({
    where: { id },
    include: {
      recurso: true,
      cargos: { select: { id: true, invoiceId: true, cancelado: true } },
      paciente: { select: { sexo: true, fechaNacimiento: true } },
      medico: { select: { id: true, nombre: true, cedula: true } },
    },
  });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  const usuario = usuarioDe(user);
  const ahora = new Date();

  const registrar = (accion: string, detalle: Record<string, unknown>) =>
    bitacora(user, req, { companyId: ep.companyId, accion, entidad: "HospEpisodio", entidadId: id, detalle: { folio: ep.folio, ...detalle } });

  // ── estado ──
  if (d.action === "estado") {
    if (d.estado === "ALTA") return error("El alta se registra con action: \"alta\"", 400);
    if (d.estado === "CANCELADO") return error("La cancelación se registra con action: \"cancelar\"", 400);
    if (!esActivo(ep.estado)) return error(`El episodio ${ep.folio} está ${ep.estado === "ALTA" ? "dado de alta" : "cancelado"}`, 409);
    if (d.estado === ep.estado) return error(`El episodio ya está ${ep.estado}`, 409);
    if (!TRANSICIONES[ep.estado].includes(d.estado)) {
      return error(`De ${ep.estado} no se pasa a ${d.estado} (permitido: ${TRANSICIONES[ep.estado].join(", ") || "ninguno"})`, 409);
    }
    // Si un programado llega antes de la hora, el ingreso es ahora.
    const adelantado = ep.estado === "PROGRAMADO" && ep.fechaIngreso.getTime() > ahora.getTime();
    const actualizado = await prisma.hospEpisodio.update({
      where: { id },
      data: { estado: d.estado, ...(adelantado ? { fechaIngreso: ahora } : {}) },
    });
    registrar("hospital.episodio.estado", { de: ep.estado, a: d.estado, nota: d.nota ?? null });
    return NextResponse.json(actualizado);
  }

  // ── traslado ──
  if (d.action === "traslado") {
    if (!esActivo(ep.estado)) return error(`El episodio ${ep.folio} ya no está activo`, 409);
    const nuevo = await prisma.hospRecurso.findUnique({ where: { id: d.recursoId } });
    if (!nuevo || nuevo.companyId !== ep.companyId) return error("recursoId inválido");
    if (nuevo.id === ep.recursoId) return error(`El paciente ya está en ${nuevo.nombre}`, 409);
    if (!nuevo.activo || nuevo.estado !== "LIBRE") return error(describirRecursoNoLibre(nuevo), 409);

    const actualizado = await prisma.$transaction(async (tx) => {
      const tomada = await tx.hospRecurso.updateMany({ where: { id: nuevo.id, estado: "LIBRE" }, data: { estado: "OCUPADA" } });
      if (tomada.count !== 1) throw new AuthzError(409, describirRecursoNoLibre({ ...nuevo, estado: "OCUPADA" }));
      if (ep.recursoId) {
        await tx.hospRecurso.update({ where: { id: ep.recursoId }, data: { estado: "LIMPIEZA" } });
      }
      await tx.hospTraslado.create({
        data: {
          episodioId: id,
          fecha: ahora,
          tipo: "TRASLADO",
          deRecursoId: ep.recursoId,
          deRecursoNombre: ep.recurso?.nombre ?? null,
          aRecursoId: nuevo.id,
          aRecursoNombre: nuevo.nombre,
          nota: d.nota?.trim() || null,
          usuarioId: usuario.id,
          usuarioNombre: usuario.nombre,
        },
      });
      return tx.hospEpisodio.update({ where: { id }, data: { recursoId: nuevo.id }, include: { recurso: true } });
    });
    registrar("hospital.episodio.traslado", { de: ep.recurso?.nombre ?? null, a: nuevo.nombre, nota: d.nota ?? null });
    return NextResponse.json(actualizado);
  }

  // ── alta ──
  if (d.action === "alta") {
    if (!esActivo(ep.estado)) return error(`El episodio ${ep.folio} ya está ${ep.estado === "ALTA" ? "dado de alta" : "cancelado"}`, 409);
    if (ep.estado === "PROGRAMADO") return error("Un episodio programado se cancela, no se da de alta", 409);
    const fechaAlta = aFecha(d.fechaAlta) ?? ahora;
    if (fechaAlta.getTime() < ep.fechaIngreso.getTime()) return error("La fecha de alta no puede ser anterior al ingreso");

    const egreso = await resolverCie(prisma, "CIE10", d.diagnosticoEgresoCie10, { etiqueta: "El diagnóstico de egreso", paciente: ep.paciente, hoy: fechaAlta });
    const procedimiento = d.procedimientoCie9?.trim()
      ? (await resolverCie(prisma, "CIE9MC", d.procedimientoCie9, { etiqueta: "El procedimiento", paciente: ep.paciente, hoy: fechaAlta })).codigo
      : ep.procedimientoCie9;

    // NOM-026: la cirugía ambulatoria egresa con la recuperación anestésica
    // concluida (Aldrete ≥ 9); defunción, traslado, fuga y alta voluntaria se
    // documentan en la nota, no cumplen criterios.
    const aldrete = d.aldreteEgreso ?? null;
    if (ep.tipo === "AMBULATORIO" && !EGRESOS_SIN_ALDRETE.has(d.motivoEgreso)) {
      if (aldrete == null) return error("El alta de cirugía ambulatoria requiere la escala de Aldrete al egreso (aldreteEgreso, NOM-026)");
      if (aldrete < ALDRETE_MINIMO) {
        return error(`Aldrete ${aldrete}/10: el paciente ambulatorio no cumple los criterios de egreso (se requiere ≥ ${ALDRETE_MINIMO}, NOM-026); registra la recuperación antes del alta`, 409);
      }
    }
    const nota = d.nota?.trim() || null;
    const instrucciones = d.instrucciones?.trim() || null;
    if (nota && !instrucciones) return error("La nota de egreso lleva el plan de manejo e instrucciones de egreso (instrucciones), NOM-004 §8.10");
    if (nota && !ep.medicoId) return error("Para la nota de egreso el episodio necesita médico tratante con cédula: asígnalo con action: \"datos\"", 409);

    const actualizado = await prisma.$transaction(async (tx) => {
      // Las noches hasta el alta se cobran ANTES de soltar la cama.
      await asegurarCargosEstancia(tx, id, fechaAlta);
      if (ep.recursoId) {
        await tx.hospRecurso.update({ where: { id: ep.recursoId }, data: { estado: "LIMPIEZA" } });
      }
      await tx.hospTraslado.create({
        data: {
          episodioId: id,
          fecha: fechaAlta,
          tipo: "ALTA",
          deRecursoId: ep.recursoId,
          deRecursoNombre: ep.recurso?.nombre ?? null,
          nota: nota ? "Alta con nota de egreso" : null,
          usuarioId: usuario.id,
          usuarioNombre: usuario.nombre,
        },
      });
      if (nota && instrucciones) {
        await crearNota(tx, {
          companyId: ep.companyId,
          episodioId: id,
          tipo: "EGRESO",
          texto: nota,
          secciones: {
            diagnosticoEgreso: `${egreso.codigo} ${egreso.nombre}`,
            motivoEgreso: d.motivoEgreso,
            evolucion: nota,
            planManejo: instrucciones,
            diasEstancia: diaDeEstancia(ep.fechaIngreso, fechaAlta),
            ...(aldrete != null ? { aldrete } : {}),
          },
          fecha: fechaAlta,
          medicoId: ep.medicoId,
          usuario,
          ahora,
        });
      }
      return tx.hospEpisodio.update({
        where: { id },
        data: {
          estado: "ALTA",
          fechaAlta,
          recursoId: null,
          motivoEgreso: d.motivoEgreso,
          diagnosticoEgresoCie10: egreso.codigo,
          procedimientoCie9: procedimiento,
          aldreteEgreso: aldrete,
        },
        include: { recurso: true, medico: { select: { id: true, nombre: true } } },
      });
    });
    registrar("hospital.episodio.alta", {
      fechaAlta: fechaAlta.toISOString(),
      cama: ep.recurso?.nombre ?? null,
      conNota: !!nota,
      motivoEgreso: d.motivoEgreso,
      diagnosticoEgresoCie10: egreso.codigo,
      aldreteEgreso: aldrete,
    });
    return NextResponse.json({ ...actualizado, cie: await nombresCie(prisma, actualizado) });
  }

  // ── seguimiento (NOM-026: llamada posterior al alta) ──
  if (d.action === "seguimiento") {
    if (ep.estado !== "ALTA") return error(`El seguimiento se registra después del alta (el episodio ${ep.folio} está ${ep.estado})`, 409);
    const seguimientoAt = aFecha(d.seguimientoAt) ?? ahora;
    if (ep.fechaAlta && seguimientoAt.getTime() < ep.fechaAlta.getTime()) return error("El seguimiento no puede ser anterior al alta");
    const actualizado = await prisma.hospEpisodio.update({
      where: { id },
      data: { seguimientoAt, seguimientoNota: d.seguimientoNota.trim() },
    });
    registrar("hospital.episodio.seguimiento", { seguimientoAt: seguimientoAt.toISOString(), previo: ep.seguimientoAt?.toISOString() ?? null });
    return NextResponse.json(actualizado);
  }

  // ── datos ──
  if (d.action === "datos") {
    if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);
    const { action: _a, triageAt, ...resto } = d;
    const campos: Record<string, unknown> = Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined));
    if (campos.medicoId) {
      const m = await prisma.hospMedico.findUnique({ where: { id: campos.medicoId as string }, select: { companyId: true } });
      if (!m || m.companyId !== ep.companyId) return error("medicoId inválido");
    }
    if (campos.pagadorId) {
      const p = await prisma.hospPagador.findUnique({ where: { id: campos.pagadorId as string }, select: { companyId: true } });
      if (!p || p.companyId !== ep.companyId) return error("pagadorId inválido");
    }
    if (campos.customerId) {
      const c = await prisma.customer.findUnique({ where: { id: campos.customerId as string }, select: { companyId: true } });
      if (!c || c.companyId !== ep.companyId) return error("customerId inválido");
    }
    if (typeof campos.diagnosticoIngresoCie10 === "string" && campos.diagnosticoIngresoCie10.trim()) {
      campos.diagnosticoIngresoCie10 = (await resolverCie(prisma, "CIE10", campos.diagnosticoIngresoCie10, { etiqueta: "El diagnóstico de ingreso", paciente: ep.paciente, hoy: ahora })).codigo;
    }
    if (typeof campos.procedimientoCie9 === "string" && campos.procedimientoCie9.trim()) {
      campos.procedimientoCie9 = (await resolverCie(prisma, "CIE9MC", campos.procedimientoCie9, { etiqueta: "El procedimiento", paciente: ep.paciente, hoy: ahora })).codigo;
    }
    if ("triageNivel" in campos) {
      validarTriage(ep.tipo, campos.triageNivel as number | null);
      campos.triageAt = campos.triageNivel == null ? null : (aFecha(triageAt) ?? ep.triageAt ?? ahora);
    } else if (triageAt !== undefined) {
      campos.triageAt = aFecha(triageAt);
    }
    if ("asa" in campos) campos.asa = normalizarAsa(campos.asa as string | null);

    const anterior = ep as unknown as Record<string, unknown>;
    const cambios = Object.entries(campos)
      .filter(([campo, nuevo]) => {
        const antes = anterior[campo] ?? null;
        const despues = nuevo ?? null;
        return (antes instanceof Date ? antes.getTime() : antes) !== (despues instanceof Date ? despues.getTime() : despues);
      })
      .map(([campo, nuevo]) => ({ campo, antes: anterior[campo] ?? null, despues: nuevo ?? null }));
    const actualizado = await prisma.hospEpisodio.update({
      where: { id },
      data: campos,
      include: { medico: true, pagador: true, customer: { select: { id: true, razonSocial: true, rfc: true } } },
    });
    if (cambios.length) registrar("hospital.episodio.editar", { cambios });
    return NextResponse.json({
      ...actualizado,
      medico: medicoResumen(actualizado.medico),
      pagador: pagadorResumen(actualizado.pagador),
      customer: customerResumen(actualizado.customer),
      cie: await nombresCie(prisma, actualizado),
    });
  }

  // ── cancelar ──
  if (!esActivo(ep.estado)) return error(`El episodio ${ep.folio} ya está ${ep.estado === "ALTA" ? "dado de alta" : "cancelado"}`, 409);
  if (ep.cargos.some((c) => c.invoiceId)) {
    return error("El episodio tiene cargos facturados: cancela primero los CFDIs", 409);
  }
  const vivos = ep.cargos.filter((c) => !c.cancelado).map((c) => c.id);
  const actualizado = await prisma.$transaction(async (tx) => {
    if (ep.recursoId) {
      // Si nunca llegó, la cama queda libre; si la ocupó, pasa por limpieza.
      await tx.hospRecurso.update({ where: { id: ep.recursoId }, data: { estado: ep.estado === "PROGRAMADO" ? "LIBRE" : "LIMPIEZA" } });
      await tx.hospTraslado.create({
        data: {
          episodioId: id,
          fecha: ahora,
          tipo: "ALTA",
          deRecursoId: ep.recursoId,
          deRecursoNombre: ep.recurso?.nombre ?? null,
          nota: `Episodio cancelado: ${d.motivo}`,
          usuarioId: usuario.id,
          usuarioNombre: usuario.nombre,
        },
      });
    }
    // Los cargos se marcan cancelados (no se borran). Los insumos ya aplicados
    // NO regresan al lote desde aquí: si de verdad no se usaron, se cancelan
    // uno por uno (DELETE /cargos/[id]) antes de cancelar el episodio.
    if (vivos.length) {
      await tx.hospCargo.updateMany({
        where: { id: { in: vivos } },
        data: { cancelado: true, canceladoAt: ahora, motivoCancelacion: `Episodio cancelado: ${d.motivo}` },
      });
    }
    return tx.hospEpisodio.update({ where: { id }, data: { estado: "CANCELADO", recursoId: null } });
  });
  registrar("hospital.episodio.cancelar", { motivo: d.motivo, cargosCancelados: vivos.length, cama: ep.recurso?.nombre ?? null });
  return NextResponse.json(actualizado);
});
