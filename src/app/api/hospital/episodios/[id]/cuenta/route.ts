/**
 * GET /api/hospital/episodios/[id]/cuenta — la cuenta del paciente (lámina 8).
 *
 * Asegura las noches de estancia, corre `calcularCuenta` y agrega lo que la
 * pantalla necesita alrededor: facturación (los CFDIs que ya amparan cargos)
 * y la conciliación expediente ↔ cuenta (lámina 17): cargos de piso/farmacia
 * sin nota y notas de aplicación/procedimiento sin cargo.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { asegurarCargosEstancia } from "@/lib/hospital/estancia";
import { calcularCuenta } from "@/lib/hospital/cuenta";
import { cargoParaCuenta, customerResumen, pacienteResumen, pagadorResumen } from "@/lib/hospital/serializar";
import { desviacionPct } from "@/lib/hospital/plan";
import { resumenDepositos } from "@/lib/hospital/depositos";
import { r2 } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const base = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, pacienteId: true } });
  if (!base) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireMembership(base.companyId, undefined, req);
  await requireModule(base.companyId, "HOSPITAL", req);
  registrarAcceso({ companyId: base.companyId, accion: "LECTURA_CUENTA", episodioId: base.id, pacienteId: base.pacienteId, detalle: `Cuenta ${base.folio}`, user, req });

  await asegurarCargosEstancia(prisma, id, new Date());

  const [ep, config] = await Promise.all([
    prisma.hospEpisodio.findUniqueOrThrow({
      where: { id },
      include: {
        paciente: true,
        pagador: true,
        customer: { select: { id: true, razonSocial: true, rfc: true } },
        medico: { select: { id: true, nombre: true } },
        cargos: {
          orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
          include: {
            lote: { select: { lote: true } },
            medico: { select: { id: true, nombre: true } },
            nota: { select: { id: true } },
            invoice: {
              select: { id: true, uuid: true, serie: true, folio: true, total: true, status: true, fecha: true, metodoPago: true, customer: { select: { razonSocial: true, rfc: true } }, contraparteNombre: true },
            },
          },
        },
        notas: {
          where: { tipo: { in: ["MEDICAMENTO_APLICADO", "PROCEDIMIENTO"] }, cargoId: null },
          select: { id: true, fecha: true, tipo: true, texto: true, reemplazadaPor: { select: { id: true } } },
        },
      },
    }),
    prisma.hospConfig.findUnique({ where: { companyId: base.companyId }, select: { topeAutorizacion: true } }),
  ]);

  const cuenta = calcularCuenta({
    cargos: ep.cargos.map(cargoParaCuenta),
    pagador: pagadorResumen(ep.pagador),
    config: { topeAutorizacion: config?.topeAutorizacion == null ? null : Number(config.topeAutorizacion) },
  });

  // ── P3a · Plan de tratamiento: total planeado y desviación de la cuenta (un solo bloque) ──
  const planDb = await prisma.hospPlanTratamiento.findUnique({
    where: { episodioId: id },
    select: { id: true, nombre: true, estado: true, total: true, autorizacionPagador: true },
  });
  const plan = planDb
    ? {
        id: planDb.id,
        nombre: planDb.nombre,
        estado: planDb.estado,
        total: Number(planDb.total),
        desviacionPct: desviacionPct(Number(planDb.total), cuenta.totales.total),
        autorizacionPagador: planDb.autorizacionPagador,
      }
    : null;
  // ── fin P3a ──

  // ── P3c · Depósitos del paciente y saldo neto (total − recibidos/aplicados), un solo bloque ──
  const depositosDb = await prisma.hospDeposito.findMany({ where: { episodioId: id }, orderBy: [{ fecha: "asc" }, { createdAt: "asc" }] });
  const depositos = depositosDb.map((d) => ({ id: d.id, fecha: d.fecha, monto: r2(Number(d.monto)), formaPago: d.formaPago, estado: d.estado }));
  const saldoNeto = r2(cuenta.totales.total - resumenDepositos(depositosDb).vigentes);
  // ── fin P3c ──

  // Facturación: cada CFDI una vez aunque ampare varios renglones.
  const facturas = new Map<string, { id: string; uuid: string | null; serie: string | null; folio: string | null; total: number; receptor: string | null; status: string; fecha: Date; metodoPago: string; cargos: number }>();
  for (const c of ep.cargos) {
    if (!c.invoice) continue;
    const previa = facturas.get(c.invoice.id);
    if (previa) {
      previa.cargos++;
      continue;
    }
    facturas.set(c.invoice.id, {
      id: c.invoice.id,
      uuid: c.invoice.uuid,
      serie: c.invoice.serie,
      folio: c.invoice.folio,
      total: r2(Number(c.invoice.total)),
      receptor: c.invoice.customer?.razonSocial ?? c.invoice.contraparteNombre ?? null,
      status: c.invoice.status,
      fecha: c.invoice.fecha,
      metodoPago: c.invoice.metodoPago,
      cargos: 1,
    });
  }
  const vivas = [...facturas.values()].filter((f) => f.status !== "CANCELLED");
  const facturado = r2(vivas.reduce((s, f) => s + f.total, 0));

  const cargosSinNota = ep.cargos.filter((c) => !c.cancelado && (c.origen === "EXPEDIENTE" || c.origen === "FARMACIA") && !c.nota);
  const notasSinCargo = ep.notas.filter((n) => !n.reemplazadaPor);

  return NextResponse.json({
    episodio: {
      id: ep.id,
      folio: ep.folio,
      tipo: ep.tipo,
      estado: ep.estado,
      fechaIngreso: ep.fechaIngreso,
      fechaAlta: ep.fechaAlta,
      procedimiento: ep.procedimiento,
      diagnostico: ep.diagnostico,
      paciente: pacienteResumen(ep.paciente),
      pagador: pagadorResumen(ep.pagador),
      customer: customerResumen(ep.customer),
      medico: ep.medico,
    },
    grupos: cuenta.grupos,
    totales: cuenta.totales,
    reparto: cuenta.reparto,
    plan, // P3a
    depositos, // P3c
    saldoNeto, // P3c
    facturacion: {
      facturado,
      porFacturar: r2(Math.max(0, cuenta.totales.total - facturado)),
      facturas: [...facturas.values()],
    },
    conciliacion: {
      cargosSinNota: cargosSinNota.length,
      notasSinCargo: notasSinCargo.length,
      detalle: {
        cargosSinNota: cargosSinNota.map((c) => ({ id: c.id, fecha: c.fecha, descripcion: c.descripcion, importe: r2(Number(c.importe)), origen: c.origen })),
        notasSinCargo: notasSinCargo.map((n) => ({ id: n.id, fecha: n.fecha, tipo: n.tipo, texto: n.texto })),
      },
    },
  });
});
