/**
 * GET /api/hospital/contabilidad/preview?companyId=&anio=&mes=
 *   → { activa, periodo, piernasCfdi: [{ invoiceId, uuid, serie, folio, fecha, subtotal, total,
 *        piernas: [{ clave, cuenta: { id, codigo, nombre }, monto }] }],
 *      asientosHospital: [{ fecha, descripcion, monto, referencia, referenciaTipo, cargo, abono, asentado }],
 *      totales }
 *
 * Lo que el módulo llevaría al libro en el mes, esté o no activa la
 * contabilidad: cómo se partiría cada CFDI ligado a cargos (piernas del motor,
 * ver contabilidad/hospital.ts) y los asientos con fuente HOSPITAL pendientes
 * y ya asentados (ver hospital/asientos.ts). El mes es el del libro (UTC).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { cargarContextoHospital, piernasIngresoHospital } from "@/lib/contabilidad/hospital";
import { periodoDeQuery, previewMes, rangoMesUtc } from "@/lib/hospital/asientos";
import { r2 } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  const periodo = periodoDeQuery(searchParams);
  if (!periodo) return error("Periodo inválido (anio, mes)");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const rango = rangoMesUtc(periodo.anio, periodo.mes);
  const ligados = await prisma.hospCargo.findMany({
    where: {
      companyId,
      cancelado: false,
      invoiceId: { not: null },
      invoice: { tipo: "INGRESO", status: "STAMPED", fecha: { gte: rango.desde, lt: rango.hasta } },
    },
    distinct: ["invoiceId"],
    select: { invoiceId: true },
  });
  const invoiceIds = ligados.map((c) => c.invoiceId!).filter(Boolean);
  const [facturas, ctx, hospital] = await Promise.all([
    invoiceIds.length
      ? prisma.invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, uuid: true, serie: true, folio: true, fecha: true, subtotal: true, total: true },
          orderBy: { fecha: "asc" },
        })
      : Promise.resolve([]),
    cargarContextoHospital(companyId, invoiceIds, { incluirInactiva: true }),
    previewMes(prisma, companyId, periodo.anio, periodo.mes),
  ]);

  let ingreso = 0;
  let honorarios = 0;
  const piernasCfdi = facturas.map((f) => {
    const subtotal = r2(Number(f.subtotal));
    const piernas = (piernasIngresoHospital(f.id, subtotal, ctx) ?? []).map((p) => {
      if (p.cuenta.tipo === "PASIVO") honorarios = r2(honorarios + p.monto);
      else ingreso = r2(ingreso + p.monto);
      return { clave: p.clave, cuenta: { id: p.cuenta.id, codigo: p.cuenta.subcuenta ?? p.cuenta.cuentaSAT, nombre: p.cuenta.nombre }, monto: p.monto };
    });
    return { invoiceId: f.id, uuid: f.uuid, serie: f.serie, folio: f.folio, fecha: f.fecha, subtotal, total: r2(Number(f.total)), piernas };
  });

  const pendientes = hospital.asientos.filter((a) => !a.asentado);
  const asentados = hospital.asientos.filter((a) => a.asentado);
  return NextResponse.json({
    activa: hospital.activa,
    periodo: { anio: periodo.anio, mes: periodo.mes, desde: rango.desde, hasta: rango.hasta },
    piernasCfdi,
    asientosHospital: hospital.asientos,
    totales: {
      cfdi: { comprobantes: piernasCfdi.length, subtotal: r2(piernasCfdi.reduce((s, f) => s + f.subtotal, 0)), ingreso, honorarios },
      hospital: {
        pendientes: pendientes.length,
        asentados: asentados.length,
        montoPendiente: r2(pendientes.reduce((s, a) => s + a.monto, 0)),
        montoAsentado: r2(asentados.reduce((s, a) => s + a.monto, 0)),
      },
    },
  });
});
