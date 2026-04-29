/**
 * GET /api/construccion/proyectos/[id]/programa
 *
 * Returns everything the Programa tab needs to render the avance chart
 * (sheet 3) + the cliente curve editor (sheet 5) + the calendario cierre
 * editor (sheet 4):
 *
 *   {
 *     proyecto:   { weekCount, fechaInicio, viviendasObjetivo, montoContratado, … },
 *     capitulos:  [{ capituloCode, descripcion, importeContrato }],
 *     curvasCliente:    [{ capituloCode, pesoPctSemanal[] }],
 *     calendarioCierre: [{ capituloCode, pesoPctSemanal[] }],
 *     estimaciones:     [{ numero, fechaCorte, importeAcumulado, pctAcumulado, estado }],
 *     weekStartDates:   [Date, Date, …]   // length = weekCount
 *   }
 *
 * Lazily creates calendario cierre rows for templates that pre-date Run 2C
 * so existing projects (Torres Platino) auto-upgrade on first open.
 *
 * Importes por capítulo se calculan a partir de la suma de las
 * EstimacionTemplatePartida del capítulo — refleja el contrato compactado
 * según la regla de Gerardo (1-15 rolled, ≥16 open).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        codigo: true,
        nombre: true,
        fechaInicio: true,
        fechaFinPlan: true,
        weekCount: true,
        viviendasObjetivo: true,
        montoContratado: true,
        aplicaIva: true,
      },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const template = await prisma.estimacionTemplate.findUnique({
      where: { proyectoId: id },
      include: {
        partidas: {
          include: {
            presupuestoPartida: { select: { importe: true } },
          },
        },
        curvas: { orderBy: { capituloCode: "asc" } },
        calendarioCierre: { orderBy: { capituloCode: "asc" } },
      },
    });
    if (!template) {
      return NextResponse.json(
        { error: "El proyecto no tiene plantilla de estimaciones." },
        { status: 422 }
      );
    }

    const weekCount = proyecto.weekCount ?? 48;

    // Sum importes per capítulo from the template partidas.
    const importeByCap = new Map<string, number>();
    const descByCap = new Map<string, string>();
    for (const tp of template.partidas) {
      const cap = tp.capituloCode;
      const imp = tp.presupuestoPartida.importe ?? 0;
      importeByCap.set(cap, (importeByCap.get(cap) ?? 0) + imp);
      if (!descByCap.has(cap)) descByCap.set(cap, tp.descripcion);
    }
    const capitulos = [...importeByCap.entries()]
      .map(([capituloCode, importe]) => ({
        capituloCode,
        descripcion: descByCap.get(capituloCode) ?? `Capítulo ${capituloCode}`,
        importeContrato: importe,
      }))
      .sort((a, b) => parseInt(a.capituloCode) - parseInt(b.capituloCode));

    // Lazy-create calendarioCierre rows for templates that don't have them
    // yet (projects bootstrapped before Run 2C).
    let calendarioCierre = template.calendarioCierre;
    if (calendarioCierre.length === 0 && capitulos.length > 0) {
      await prisma.calendarioCierreCapitulo.createMany({
        data: capitulos.map((c) => ({
          templateId: template.id,
          capituloCode: c.capituloCode,
          descripcion: c.descripcion,
          pesoPctSemanal: new Array(weekCount).fill(0),
        })),
      });
      calendarioCierre = await prisma.calendarioCierreCapitulo.findMany({
        where: { templateId: template.id },
        orderBy: { capituloCode: "asc" },
      });
    }

    // Estimaciones for the real curve.
    const estimaciones = await prisma.estimacion.findMany({
      where: { proyectoId: id },
      orderBy: { numero: "asc" },
      select: {
        id: true,
        numero: true,
        fechaCorte: true,
        periodoFin: true,
        estado: true,
        total: true,
        importeAcumulado: true,
        pctPeriodo: true,
        pctAcumulado: true,
      },
    });

    // Compute weekStartDates: fechaInicio + 7d × i, for i = 0..weekCount-1
    const start = proyecto.fechaInicio
      ? new Date(proyecto.fechaInicio)
      : null;
    const weekStartDates: string[] = [];
    if (start) {
      for (let i = 0; i < weekCount; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i * 7);
        weekStartDates.push(d.toISOString());
      }
    }

    return NextResponse.json({
      proyecto: {
        id: proyecto.id,
        codigo: proyecto.codigo,
        nombre: proyecto.nombre,
        fechaInicio: proyecto.fechaInicio,
        fechaFinPlan: proyecto.fechaFinPlan,
        weekCount,
        viviendasObjetivo: proyecto.viviendasObjetivo,
        montoContratado: proyecto.montoContratado,
        aplicaIva: proyecto.aplicaIva,
      },
      capitulos,
      curvasCliente: template.curvas.map((c) => ({
        id: c.id,
        capituloCode: c.capituloCode,
        descripcion: c.descripcion,
        pesoPctSemanal: c.pesoPctSemanal,
      })),
      calendarioCierre: calendarioCierre.map((c) => ({
        id: c.id,
        capituloCode: c.capituloCode,
        descripcion: c.descripcion,
        pesoPctSemanal: c.pesoPctSemanal,
      })),
      estimaciones,
      weekStartDates,
    });
  }
);
