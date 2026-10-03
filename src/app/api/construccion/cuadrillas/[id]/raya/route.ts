/**
 * POST /api/construccion/cuadrillas/[id]/raya   { semana: "YYYY-MM-DD" }
 *
 * Genera (o regenera) la raya de la cuadrilla para la semana que contiene
 * `semana`, a partir de la asistencia capturada: un detalle por miembro con
 * sus horas, horas extra y jornal (tarifa por día u hora del trabajador,
 * extra al doble), menos sus anticipos. total = jornales + destajo.
 *
 * - Sin raya esa semana: la crea en BORRADOR.
 * - Raya en BORRADOR: regenera los jornales; conserva el destajo capturado y
 *   los anticipos por miembro.
 * - Raya autorizada o pagada: 409 — lo autorizado no se recalcula.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import {
  calcularDetalle,
  fechaDia,
  rangoSemana,
  totalesRaya,
  type TipoPago,
} from "@/lib/construccion/raya-calculo";

const schema = z.object({ semana: z.string() });

const HORA_LOCAL = 6; // 00:00 en México (UTC-6), igual que la captura manual

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "semana requerida (YYYY-MM-DD)" }, { status: 400 });
    }
    const cuadrilla = await prisma.cuadrilla.findUnique({
      where: { id },
      select: { id: true, companyId: true, proyectoId: true },
    });
    if (!cuadrilla) throw new AuthzError(404, "Cuadrilla no encontrada");
    await requireWriter(cuadrilla.companyId, req);
    await requireModule(cuadrilla.companyId, "CONSTRUCCION");

    let desde: Date, hasta: Date;
    try {
      ({ desde, hasta } = rangoSemana(fechaDia(parsed.data.semana)));
    } catch {
      return NextResponse.json({ error: "semana inválida (YYYY-MM-DD)" }, { status: 400 });
    }

    // Asistencia de la semana en esta cuadrilla, con la tarifa del trabajador.
    const asistencias = await prisma.asistencia.findMany({
      where: { cuadrillaId: id, fecha: { gte: desde, lt: hasta } },
      select: {
        trabajadorId: true,
        horas: true,
        horasExtra: true,
        trabajador: { select: { tipoPago: true, tarifa: true, horasJornada: true } },
      },
    });
    // Miembro de la cuadrilla que corresponde a cada trabajador (aunque
    // después lo hayan dado de baja: su semana trabajada se paga igual).
    const miembros = await prisma.cuadrillaMiembro.findMany({
      where: { cuadrillaId: id, trabajadorId: { in: [...new Set(asistencias.map((a) => a.trabajadorId))] } },
      select: { id: true, trabajadorId: true, isActive: true },
      orderBy: { isActive: "desc" },
    });
    const miembroDe = new Map<string, string>();
    for (const m of miembros) if (m.trabajadorId && !miembroDe.has(m.trabajadorId)) miembroDe.set(m.trabajadorId, m.id);

    const finDia = new Date(desde);
    finDia.setUTCDate(finDia.getUTCDate() + 1);
    const existente = await prisma.rayaSemanal.findFirst({
      where: { cuadrillaId: id, semanaInicio: { gte: desde, lt: finDia } },
      select: {
        id: true,
        estado: true,
        totalDestajo: true,
        detalles: { select: { miembroId: true, descuento: true } },
      },
    });
    if (existente && existente.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `La raya de esta semana ya está ${existente.estado.toLowerCase()}; no se recalcula` },
        { status: 409 }
      );
    }
    if (!existente && asistencias.length === 0) {
      return NextResponse.json(
        { error: "No hay asistencia capturada en esta semana para esta cuadrilla" },
        { status: 422 }
      );
    }

    // Jornal por miembro (anticipos previos se conservan al regenerar).
    const descuentoPrevio = new Map(
      (existente?.detalles ?? []).map((d) => [d.miembroId, Number(d.descuento)])
    );
    const porTrabajador = new Map<string, typeof asistencias>();
    for (const a of asistencias) {
      const arr = porTrabajador.get(a.trabajadorId) ?? [];
      arr.push(a);
      porTrabajador.set(a.trabajadorId, arr);
    }
    const detalles = [...porTrabajador.entries()]
      .filter(([trabajadorId]) => miembroDe.has(trabajadorId))
      .map(([trabajadorId, filas]) => {
        const miembroId = miembroDe.get(trabajadorId)!;
        const t = filas[0].trabajador;
        const calc = calcularDetalle(
          { tipoPago: t.tipoPago as TipoPago, tarifa: Number(t.tarifa), horasJornada: Number(t.horasJornada) },
          filas.map((f) => ({ horas: Number(f.horas), horasExtra: Number(f.horasExtra) })),
          descuentoPrevio.get(miembroId) ?? 0
        );
        return { miembroId, ...calc };
      });

    const totalDestajo = Number(existente?.totalDestajo ?? 0);
    const { totalJornales, total } = totalesRaya(detalles.map((d) => d.importe), totalDestajo);

    const raya = await prisma.$transaction(async (tx) => {
      let rayaId = existente?.id;
      if (!rayaId) {
        const inicio = new Date(desde);
        inicio.setUTCHours(HORA_LOCAL);
        const fin = new Date(hasta);
        fin.setUTCHours(HORA_LOCAL);
        fin.setUTCMilliseconds(-1); // domingo 23:59:59.999 local
        const creada = await tx.rayaSemanal.create({
          data: {
            companyId: cuadrilla.companyId,
            proyectoId: cuadrilla.proyectoId,
            cuadrillaId: id,
            semanaInicio: inicio,
            semanaFin: fin,
          },
          select: { id: true },
        });
        rayaId = creada.id;
      }
      // Fuera los jornales anteriores (y cualquier detalle de los miembros
      // que ahora llevan jornal: un detalle por miembro y raya).
      await tx.rayaDetalleMiembro.deleteMany({
        where: {
          rayaId,
          OR: [
            { horas: { gt: 0 } },
            { horasExtra: { gt: 0 } },
            { miembroId: { in: detalles.map((d) => d.miembroId) } },
          ],
        },
      });
      if (detalles.length) {
        await tx.rayaDetalleMiembro.createMany({
          data: detalles.map((d) => ({
            rayaId: rayaId!,
            miembroId: d.miembroId,
            diasTrabajados: d.diasTrabajados,
            horas: d.horas,
            horasExtra: d.horasExtra,
            descuento: d.descuento,
            importe: d.importe,
          })),
        });
      }
      return tx.rayaSemanal.update({
        where: { id: rayaId },
        data: { totalJornales, total },
        include: {
          trabajos: true,
          detalles: {
            include: {
              miembro: {
                select: {
                  id: true,
                  nombre: true,
                  trabajador: { select: { id: true, nombre: true, tipoPago: true, tarifa: true } },
                },
              },
            },
          },
          cuadrilla: { select: { id: true, nombre: true, especialidad: true } },
        },
      });
    });

    return NextResponse.json(raya, { status: existente ? 200 : 201 });
  }
);
