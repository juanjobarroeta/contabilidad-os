/**
 * GET /api/hospital/medicos/honorarios?companyId=…&anio=2026&mes=8
 *
 * «El honorario pasa por la cuenta sin ser ingreso del hospital» (lámina 16).
 * Por médico y mes:
 *   delMes          Σ cargos HONORARIO vivos del mes (con su IVA, casi siempre exento)
 *   eventos         episodios distintos con esos cargos
 *   cobrado         Σ de esos cargos cuyo CFDI ya tiene evidencia de cobro
 *                   (PUE = cobrada al emitirse; PPD = conciliación ≥ total),
 *                   misma regla que automotriz/perfil-contacto
 *   facturaRecibida Σ CFDIs EGRESO del mes cuya contraparte es el RFC del
 *                   médico o de su proveedor (la factura que él nos emite)
 *   dispersado      Σ de esos EGRESO con conciliación bancaria (lo que ya se le pagó)
 *   porDispersar    max(0, cobrado − dispersado)
 *   facturaPendiente max(0, facturaRecibida − dispersado): facturó y aún no se le paga
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { partesLocales, rangoMesLocal } from "@/lib/hospital/tz";
import { r2 } from "@/lib/hospital/util";

type Estado = "DISPERSADO" | "FACTURA_RECIBIDA" | "POR_COBRAR" | "SIN_EVENTOS";

const conciliado = (f: { conciliacionDetalles: Array<{ montoAsignado: unknown }> }) =>
  r2(f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0));

/** PUE se cobra al emitirse; PPD sólo con conciliación bancaria que la cubra. */
const cobrada = (f: { metodoPago: string; status: string; total: unknown; conciliacionDetalles: Array<{ montoAsignado: unknown }> }) =>
  f.status !== "CANCELLED" && (f.metodoPago === "PUE" || conciliado(f) >= Number(f.total) - 0.01);

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = partesLocales(new Date());
  const anio = Number(searchParams.get("anio") || hoy.y);
  const mes = Number(searchParams.get("mes") || hoy.m);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return error("Periodo inválido (anio, mes)");
  }
  const rango = rangoMesLocal(anio, mes);

  const [medicos, cargos] = await Promise.all([
    prisma.hospMedico.findMany({
      where: { companyId },
      select: { id: true, nombre: true, especialidad: true, rfc: true, activo: true, supplier: { select: { id: true, rfc: true, razonSocial: true } } },
      orderBy: { nombre: "asc" },
    }),
    prisma.hospCargo.findMany({
      where: { companyId, categoria: "HONORARIO", cancelado: false, medicoId: { not: null }, fecha: { gte: rango.desde, lt: rango.hasta } },
      select: {
        medicoId: true,
        episodioId: true,
        importe: true,
        ivaTasa: true,
        invoice: { select: { id: true, total: true, metodoPago: true, status: true, conciliacionDetalles: { select: { montoAsignado: true } } } },
      },
    }),
  ]);

  // RFC → médico (el suyo y el de su proveedor), para empatar sus CFDIs de egreso.
  const porRfc = new Map<string, string>();
  for (const m of medicos) {
    for (const rfc of [m.rfc, m.supplier?.rfc]) if (rfc) porRfc.set(rfc.toUpperCase(), m.id);
  }
  const rfcs = [...porRfc.keys()];
  const egresos = rfcs.length
    ? await prisma.invoice.findMany({
        where: {
          companyId,
          tipo: "EGRESO",
          status: { not: "CANCELLED" },
          fecha: { gte: rango.desde, lt: rango.hasta },
          OR: [{ contraparteRfc: { in: rfcs } }, { customer: { rfc: { in: rfcs } } }],
        },
        select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, tipoSat: true, metodoPago: true, status: true, contraparteRfc: true, customer: { select: { rfc: true } }, conciliacionDetalles: { select: { montoAsignado: true } } },
      })
    : [];

  type Acum = { eventos: Set<string>; delMes: number; cobrado: number; facturaRecibida: number; dispersado: number; facturas: Array<{ id: string; uuid: string | null; serie: string | null; folio: string | null; fecha: Date; total: number; dispersado: number }> };
  const acum = new Map<string, Acum>();
  const de = (id: string) => {
    let a = acum.get(id);
    if (!a) {
      a = { eventos: new Set(), delMes: 0, cobrado: 0, facturaRecibida: 0, dispersado: 0, facturas: [] };
      acum.set(id, a);
    }
    return a;
  };

  for (const c of cargos) {
    const a = de(c.medicoId!);
    const importe = Number(c.importe);
    const total = r2(importe + (c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa))));
    a.eventos.add(c.episodioId);
    a.delMes = r2(a.delMes + total);
    if (c.invoice && cobrada(c.invoice)) a.cobrado = r2(a.cobrado + total);
  }
  for (const f of egresos) {
    if ((f.tipoSat ?? "I") === "E") continue; // nota de crédito: no es factura de honorarios
    const rfc = (f.contraparteRfc ?? f.customer?.rfc ?? "").toUpperCase();
    const medicoId = porRfc.get(rfc);
    if (!medicoId) continue;
    const a = de(medicoId);
    const total = r2(Number(f.total));
    const pagado = r2(Math.min(total, conciliado(f)));
    a.facturaRecibida = r2(a.facturaRecibida + total);
    a.dispersado = r2(a.dispersado + pagado);
    a.facturas.push({ id: f.id, uuid: f.uuid, serie: f.serie, folio: f.folio, fecha: f.fecha, total, dispersado: pagado });
  }

  const filas = medicos
    .filter((m) => m.activo || acum.has(m.id))
    .map((m) => {
      const a = acum.get(m.id) ?? { eventos: new Set<string>(), delMes: 0, cobrado: 0, facturaRecibida: 0, dispersado: 0, facturas: [] };
      const porDispersar = r2(Math.max(0, a.cobrado - a.dispersado));
      const facturaPendiente = r2(Math.max(0, a.facturaRecibida - a.dispersado));
      let estado: Estado;
      if (a.eventos.size === 0 && a.facturaRecibida === 0) estado = "SIN_EVENTOS";
      else if (a.dispersado > 0 && porDispersar === 0 && facturaPendiente === 0) estado = "DISPERSADO";
      else if (a.facturaRecibida > 0) estado = "FACTURA_RECIBIDA";
      else estado = "POR_COBRAR";
      return {
        id: m.id,
        nombre: m.nombre,
        especialidad: m.especialidad,
        rfc: m.rfc,
        supplier: m.supplier,
        eventos: a.eventos.size,
        delMes: a.delMes,
        cobrado: a.cobrado,
        facturaRecibida: a.facturaRecibida,
        dispersado: a.dispersado,
        porDispersar,
        facturaPendiente,
        estado,
        facturas: a.facturas,
      };
    });

  return NextResponse.json({
    periodo: { anio, mes, desde: rango.desde, hasta: rango.hasta },
    totales: {
      cargado: r2(filas.reduce((s, f) => s + f.delMes, 0)),
      cobrado: r2(filas.reduce((s, f) => s + f.cobrado, 0)),
      facturaRecibida: r2(filas.reduce((s, f) => s + f.facturaRecibida, 0)),
      dispersado: r2(filas.reduce((s, f) => s + f.dispersado, 0)),
      porDispersar: r2(filas.reduce((s, f) => s + f.porDispersar, 0)),
      facturaPendiente: r2(filas.reduce((s, f) => s + f.facturaPendiente, 0)),
    },
    medicos: filas,
  });
});
