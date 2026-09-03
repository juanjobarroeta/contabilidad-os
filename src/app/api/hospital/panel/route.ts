/**
 * GET /api/hospital/panel?companyId=…
 *
 * Tablero de dirección («todo el hospital, y los impuestos, en una pantalla»):
 * ocupación de camas, cirugías de hoy, por cobrar con su parte vencida,
 * efectivo (bancos − comprometido en cuentas por pagar), impuestos del MES
 * ANTERIOR (el que se declara el 17), los movimientos del día con el total
 * de su cuenta y el feed «Requiere atención». Todo derivado de datos que el
 * hub o el módulo ya poseen; sólo lectura. Forma de respuesta: docs/HOSPITAL.md.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { retencionesDelPeriodo } from "@/lib/fiscal/retenciones";
import { fechaLimiteDeclaracion } from "@/lib/fiscal/checklist-declaracion";
import { isrRetenidoMedicosDelPeriodo } from "@/lib/hospital/isr-medicos";
import {
  amparadoDe,
  amparadoPorReps,
  conciliadoDe,
  diasDesde,
  pagadoPorEvidencia,
  r2,
} from "@/lib/hospital/cobranza";
import {
  AREA_LABEL,
  ESTADOS_EPISODIO_ACTIVO,
  fechaIso,
  nombrePaciente,
  totalCargo,
} from "@/lib/hospital/formato";

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_MOVIMIENTOS = 8;
const MAX_POR_ALERTA = 10;

type Atencion = {
  tipo: "LOTE_CADUCA" | "BAJO_MINIMO" | "EGRESO_PENDIENTE" | "CONVENIO_VENCE" | "AUTORIZACION";
  titulo: string;
  detalle: string;
  href: string;
  /** Id del registro que motiva la alerta (lote, insumo, episodio o pagador). */
  refId: string;
};

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const finHoy = new Date(inicioHoy.getTime() + DIA_MS);
  const inicioAyer = new Date(inicioHoy.getTime() - DIA_MS);
  const en30dias = new Date(inicioHoy.getTime() + 30 * DIA_MS);
  // Los lotes se piden con un año de ventana y se acotan después con la
  // ventana de la empresa (HospConfig), que viene en el mismo Promise.all.
  const enUnAnio = new Date(inicioHoy.getTime() + 366 * DIA_MS);
  // Impuestos del MES ANTERIOR: el que está por declararse.
  const previo = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const pYear = previo.getFullYear();
  const pMonth = previo.getMonth() + 1;

  // Sólo las PPD pueden tener saldo (la PUE queda pagada en su emisión), así
  // que la cartera del panel no carga el archivo entero de CFDIs.
  const facturaAbierta = {
    companyId,
    status: { not: "CANCELLED" as const },
    metodoPago: "PPD",
    OR: [{ tipoSat: null }, { tipoSat: { not: "E" } }],
  };
  const selectFactura = {
    uuid: true,
    total: true,
    fecha: true,
    metodoPago: true,
    conciliacionDetalles: { select: { montoAsignado: true } },
  } as const;

  const [
    config, camas, cirugias, porCobrarDb, porPagarDb, saldosBanco,
    fiscal, retenciones, medicos, activos, altasRecientes, lotesDb,
    insumosConMinimo, existencias, pagadoresPorVencer,
  ] = await Promise.all([
    prisma.hospConfig.findUnique({
      where: { companyId },
      select: { diasAlertaCaducidad: true, topeAutorizacion: true },
    }),
    prisma.hospRecurso.groupBy({
      by: ["estado"],
      where: { companyId, tipo: "CAMA", activo: true },
      _count: { _all: true },
    }),
    prisma.hospCita.groupBy({
      by: ["estado"],
      where: { companyId, tipo: "CIRUGIA", inicio: { gte: inicioHoy, lt: finHoy } },
      _count: { _all: true },
    }),
    prisma.invoice.findMany({ where: { ...facturaAbierta, tipo: "INGRESO" }, select: selectFactura }),
    prisma.invoice.findMany({ where: { ...facturaAbierta, tipo: "EGRESO" }, select: selectFactura }),
    // Saldo de cada cuenta = el saldo que trae su ÚLTIMO movimiento (misma
    // derivación que /api/bancos), en una sola consulta.
    prisma.$queryRaw<Array<{ bankAccountId: string; saldo: number | null }>>`
      SELECT DISTINCT ON (t."bankAccountId") t."bankAccountId", t.saldo::float8 AS saldo
      FROM "BankTransaction" t
      WHERE t."companyId" = ${companyId}
      ORDER BY t."bankAccountId", t.fecha DESC, t."createdAt" DESC`,
    computeTaxPosition(companyId, pYear, pMonth),
    retencionesDelPeriodo(companyId, pYear, pMonth),
    isrRetenidoMedicosDelPeriodo(prisma, companyId, pYear, pMonth),
    // Lo que ocupa el hospital hoy, más las altas de hoy (siguen en la lista
    // del día como «Alta hoy»).
    prisma.hospEpisodio.findMany({
      where: {
        companyId,
        OR: [
          { estado: { in: [...ESTADOS_EPISODIO_ACTIVO] } },
          { estado: "ALTA", fechaAlta: { gte: inicioHoy } },
        ],
      },
      select: {
        id: true, folio: true, estado: true, tipo: true, fechaIngreso: true, fechaAlta: true,
        autorizacionPagador: true,
        paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
        recurso: { select: { id: true, nombre: true, tipo: true, area: true } },
        medico: { select: { id: true, nombre: true } },
        pagador: { select: { id: true, nombre: true, topeAutorizacion: true } },
        cargos: { where: { cancelado: false }, select: { importe: true, ivaTasa: true } },
      },
      orderBy: { fechaIngreso: "desc" },
    }),
    prisma.hospEpisodio.findMany({
      where: { companyId, estado: "ALTA", fechaAlta: { gte: inicioAyer } },
      select: {
        id: true, folio: true, fechaAlta: true,
        paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
        documentos: { where: { tipo: "NOTA_EGRESO" }, select: { estado: true } },
        notas: { where: { tipo: "EGRESO" }, select: { id: true }, take: 1 },
      },
    }),
    prisma.hospLote.findMany({
      where: { companyId, existencia: { gt: 0 }, caducidad: { lte: enUnAnio } },
      select: {
        id: true, lote: true, caducidad: true, existencia: true, costoUnitario: true,
        insumo: { select: { id: true, nombre: true, unidad: true } },
      },
      orderBy: { caducidad: "asc" },
    }),
    prisma.hospInsumo.findMany({
      where: { companyId, activo: true, minimo: { gt: 0 } },
      select: { id: true, nombre: true, unidad: true, minimo: true },
    }),
    prisma.hospMovimientoInsumo.groupBy({
      by: ["insumoId"],
      where: { companyId },
      _sum: { cantidad: true },
    }),
    prisma.hospPagador.findMany({
      where: { companyId, activo: true, vigenciaFin: { lte: en30dias } },
      select: { id: true, nombre: true, vigenciaFin: true },
      orderBy: { vigenciaFin: "asc" },
    }),
  ]);

  // ── Ocupación y cirugías ──
  const camasTotal = camas.reduce((s, c) => s + c._count._all, 0);
  const ocupadas = camas.find((c) => c.estado === "OCUPADA")?._count._all ?? 0;
  const cirugiasPor = (estados: string[]) =>
    cirugias.filter((c) => estados.includes(c.estado)).reduce((s, c) => s + c._count._all, 0);

  // ── Por cobrar / comprometido: misma evidencia que la cartera ──
  const amparado = await amparadoPorReps(prisma, [...porCobrarDb, ...porPagarDb].map((f) => f.uuid));
  const saldoDe = (f: (typeof porCobrarDb)[number]) =>
    pagadoPorEvidencia({
      metodoPago: f.metodoPago,
      total: Number(f.total),
      conciliado: conciliadoDe(f.conciliacionDetalles),
      amparadoRep: amparadoDe(amparado, f.uuid),
    }).saldo;
  const porCobrar = { total: 0, masDe30: 0, facturas: 0 };
  for (const f of porCobrarDb) {
    const saldo = saldoDe(f);
    if (saldo <= 0.5) continue; // tolerancia de centavos
    porCobrar.total += saldo;
    porCobrar.facturas += 1;
    if (diasDesde(f.fecha, hoy) > 30) porCobrar.masDe30 += saldo;
  }
  let comprometido = 0;
  let porPagarFacturas = 0;
  for (const f of porPagarDb) {
    const saldo = saldoDe(f);
    if (saldo <= 0.5) continue;
    comprometido += saldo;
    porPagarFacturas += 1;
  }
  const saldoBancos = r2(saldosBanco.reduce((s, b) => s + (b.saldo ?? 0), 0));

  // ── Movimientos del día ──
  const cuentaDe = (e: { cargos: Array<{ importe: unknown; ivaTasa: unknown }> }) =>
    r2(e.cargos.reduce((s, c) => s + totalCargo(c), 0));
  const areaDe = (e: (typeof activos)[number]) => {
    if (!e.recurso) return e.tipo === "AMBULATORIO" ? "Ambulatorio" : "Sin cama";
    const label = AREA_LABEL[e.recurso.area];
    return e.recurso.tipo === "CAMA" ? `Cama ${e.recurso.nombre} · ${label}` : e.recurso.nombre;
  };
  const movimientosHoy = activos.slice(0, MAX_MOVIMIENTOS).map((e) => ({
    episodioId: e.id,
    id: e.id,
    folio: e.folio,
    paciente: nombrePaciente(e.paciente),
    area: areaDe(e),
    recurso: e.recurso,
    estado: e.estado,
    medico: e.medico?.nombre ?? null,
    pagador: e.pagador?.nombre ?? null,
    cuentaTotal: cuentaDe(e),
    diaEstancia: Math.max(1, diasDesde(e.fechaIngreso, hoy) + 1),
    altaHoy: e.estado === "ALTA",
  }));

  // ── Requiere atención ──
  const diasAlerta = config?.diasAlertaCaducidad ?? 90;
  const topeDefault = config?.topeAutorizacion == null ? null : Number(config.topeAutorizacion);
  const existenciaDe = new Map(existencias.map((x) => [x.insumoId, Number(x._sum.cantidad ?? 0)]));
  const atencion: Atencion[] = [];

  const lotes = lotesDb.filter((l) => l.caducidad && diasDesde(hoy, l.caducidad) <= diasAlerta);
  for (const l of lotes.slice(0, MAX_POR_ALERTA)) {
    const dias = diasDesde(hoy, l.caducidad!);
    atencion.push({
      tipo: "LOTE_CADUCA",
      titulo:
        dias < 0
          ? `${l.insumo.nombre} caducó hace ${-dias} día${dias === -1 ? "" : "s"}`
          : dias === 0
            ? `${l.insumo.nombre} caduca hoy`
            : `${l.insumo.nombre} caduca en ${dias} día${dias === 1 ? "" : "s"}`,
      detalle: `lote ${l.lote} · ${r2(Number(l.existencia))} ${l.insumo.unidad}`,
      href: "/farmacia",
      refId: l.id,
    });
  }

  const bajoMinimo = insumosConMinimo
    .map((i) => ({ ...i, existencia: existenciaDe.get(i.id) ?? 0, minimo: Number(i.minimo) }))
    .filter((i) => i.existencia < i.minimo)
    .sort((a, b) => a.existencia / a.minimo - b.existencia / b.minimo);
  for (const i of bajoMinimo.slice(0, MAX_POR_ALERTA)) {
    atencion.push({
      tipo: "BAJO_MINIMO",
      titulo: `${i.nombre} bajo mínimo`,
      detalle: `${r2(i.existencia)} de ${r2(i.minimo)} ${i.unidad}`,
      href: "/farmacia",
      refId: i.id,
    });
  }

  // Alta sin nota de egreso: el documento NOTA_EGRESO sigue PENDIENTE, o no
  // hay documento ni nota clínica de EGRESO en el expediente.
  for (const e of altasRecientes) {
    const doc = e.documentos[0];
    const pendiente = doc ? doc.estado === "PENDIENTE" : e.notas.length === 0;
    if (!pendiente) continue;
    atencion.push({
      tipo: "EGRESO_PENDIENTE",
      titulo: `Nota de egreso pendiente · ${e.folio}`,
      detalle: `${nombrePaciente(e.paciente)} · alta ${e.fechaAlta ? fechaIso(e.fechaAlta) : "—"}`,
      href: `/episodios/${e.id}`,
      refId: e.id,
    });
  }

  for (const p of pagadoresPorVencer) {
    const dias = diasDesde(hoy, p.vigenciaFin!);
    atencion.push({
      tipo: "CONVENIO_VENCE",
      titulo:
        dias < 0
          ? `Convenio ${p.nombre} venció hace ${-dias} día${dias === -1 ? "" : "s"}`
          : `Convenio ${p.nombre} vence en ${dias} día${dias === 1 ? "" : "s"}`,
      detalle: `vigencia hasta ${fechaIso(p.vigenciaFin!)}`,
      href: "/convenios",
      refId: p.id,
    });
  }

  // Cuenta arriba del tope del convenio y sin folio de autorización.
  for (const e of activos) {
    if (e.estado === "ALTA" || !e.pagador) continue;
    const tope = e.pagador.topeAutorizacion == null ? topeDefault : Number(e.pagador.topeAutorizacion);
    if (tope == null || tope <= 0) continue;
    if (e.autorizacionPagador?.trim()) continue;
    const total = cuentaDe(e);
    if (total <= tope) continue;
    atencion.push({
      tipo: "AUTORIZACION",
      titulo: `Cuenta de ${nombrePaciente(e.paciente)} requiere autorización de ${e.pagador.nombre}`,
      detalle: `$${total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} supera el tope de $${tope.toLocaleString("es-MX", { minimumFractionDigits: 2 })} · ${e.folio}`,
      href: `/episodios/${e.id}/cuenta`,
      refId: e.id,
    });
  }

  const totalSat = r2(
    Math.max(fiscal.iva.pagar, 0) + Math.max(fiscal.isr.isrPagar ?? 0, 0) + retenciones.aEnterar
  );

  return NextResponse.json({
    hoy: fechaIso(hoy),
    ocupacion: {
      ocupadas,
      camas: camasTotal,
      pct: camasTotal > 0 ? Math.round((ocupadas / camasTotal) * 100) : 0,
      porEstado: Object.fromEntries(camas.map((c) => [c.estado, c._count._all])),
    },
    cirugiasHoy: {
      total: cirugiasPor(["PROGRAMADA", "CONFIRMADA", "EN_CURSO", "TERMINADA"]),
      enCurso: cirugiasPor(["EN_CURSO"]),
      programadas: cirugiasPor(["PROGRAMADA", "CONFIRMADA"]),
      terminadas: cirugiasPor(["TERMINADA"]),
    },
    porCobrar: {
      total: r2(porCobrar.total),
      masDe30: r2(porCobrar.masDe30),
      facturas: porCobrar.facturas,
    },
    efectivo: {
      saldoBancos,
      comprometido: r2(comprometido),
      libre30: r2(saldoBancos - comprometido),
      cuentas: saldosBanco.length,
      facturasPorPagar: porPagarFacturas,
    },
    impuestos: {
      year: pYear,
      month: pMonth,
      ivaCargo: r2(fiscal.iva.trasladado),
      ivaAcreditable: r2(fiscal.iva.acreditable),
      ivaPorPagar: r2(Math.max(fiscal.iva.pagar, 0)),
      ivaSaldoAFavor: r2(fiscal.iva.saldoAFavor),
      isrPorPagar: r2(Math.max(fiscal.isr.isrPagar ?? 0, 0)),
      isrRetenidoMedicos: medicos.monto,
      retenciones: retenciones.aEnterar,
      totalSat,
      fechaLimite: fechaIso(fechaLimiteDeclaracion(pYear, pMonth)),
    },
    movimientosHoy,
    atencion,
    resumenAtencion: {
      total: atencion.length,
      lotesPorCaducar: lotes.length,
      bajoMinimo: bajoMinimo.length,
      episodiosActivos: activos.filter((e) => e.estado !== "ALTA").length,
    },
  });
});
