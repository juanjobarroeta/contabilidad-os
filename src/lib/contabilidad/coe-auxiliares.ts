// ─────────────────────────────────────────────────────────────────────────────
// COE — Auxiliares (Anexo 24), a solicitud del SAT:
//   • Auxiliar de Cuentas (AuxiliarCtas_1_3): por cuenta, saldo inicial/final y
//     el detalle de movimientos del periodo.
//   • Auxiliar de Folios (AuxiliarFolios_1_3): por póliza, los CFDIs (folios)
//     que la integran.
// render* puros (validables vs XSD); generate* leen la base. NumUnIdenPol coincide
// con el de las Pólizas (numerarPolizas).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { assertMesPosteado } from "./coe-xml";
import { rfcDesdeXml } from "./coe-polizas";
import { balanza } from "./posting";
import { clavePoliza, numerarPolizas, type TipoSolicitud, type CompNalInput } from "./coe-polizas";

const VERSION = "1.3";
const esc = (s: string | null | undefined): string =>
  s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const money = (n: number): string => n.toFixed(2);
const mm = (m: number): string => String(m).padStart(2, "0");

function identAttr(tipo: TipoSolicitud, numOrden?: string | null, numTramite?: string | null): string {
  if (tipo === "AF" || tipo === "FC") return numOrden ? ` NumOrden="${esc(numOrden)}"` : "";
  return numTramite ? ` NumTramite="${esc(numTramite)}"` : "";
}

// ── Auxiliar de Cuentas ──────────────────────────────────────────────────────

export interface AuxCtaMovimiento {
  fecha: string;
  numUnIdenPol: string;
  concepto: string;
  debe: number;
  haber: number;
}
export interface AuxCtaInput {
  numCta: string;
  desCta: string;
  saldoIni: number; // magnitud
  saldoFin: number; // magnitud
  movimientos: AuxCtaMovimiento[];
}

export function renderAuxiliarCtasXml(args: {
  rfc: string;
  year: number;
  month: number;
  tipoSolicitud: TipoSolicitud;
  numOrden?: string | null;
  numTramite?: string | null;
  cuentas: AuxCtaInput[];
}): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<AuxiliarCtas:AuxiliarCtas xmlns:AuxiliarCtas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd" ` +
      `Version="${VERSION}" RFC="${esc(args.rfc)}" Mes="${mm(args.month)}" Anio="${args.year}" TipoSolicitud="${args.tipoSolicitud}"${identAttr(args.tipoSolicitud, args.numOrden, args.numTramite)}>`,
  ];
  for (const c of args.cuentas) {
    // El XSD exige ≥1 DetalleAux por Cuenta: una cuenta con saldo pero sin
    // movimientos en el periodo no va (no hay auxiliar que reportar).
    if (c.movimientos.length === 0) continue;
    lines.push(
      `  <AuxiliarCtas:Cuenta NumCta="${esc(c.numCta)}" DesCta="${esc(c.desCta)}" SaldoIni="${money(c.saldoIni)}" SaldoFin="${money(c.saldoFin)}">`,
    );
    for (const m of c.movimientos) {
      lines.push(
        `    <AuxiliarCtas:DetalleAux Fecha="${esc(m.fecha)}" NumUnIdenPol="${esc(m.numUnIdenPol)}" ` +
          `Concepto="${esc(m.concepto || "Movimiento")}" Debe="${money(m.debe)}" Haber="${money(m.haber)}" />`,
      );
    }
    lines.push(`  </AuxiliarCtas:Cuenta>`);
  }
  lines.push(`</AuxiliarCtas:AuxiliarCtas>`);
  return lines.join("\n");
}

// ── Auxiliar de Folios ───────────────────────────────────────────────────────

export interface DetAuxFolInput {
  numUnIdenPol: string;
  fecha: string;
  comprobantes: CompNalInput[];
}

export function renderAuxiliarFoliosXml(args: {
  rfc: string;
  year: number;
  month: number;
  tipoSolicitud: TipoSolicitud;
  numOrden?: string | null;
  numTramite?: string | null;
  detalles: DetAuxFolInput[];
}): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<RepAuxFol:RepAuxFol xmlns:RepAuxFol="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarFolios" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarFolios http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarFolios/AuxiliarFolios_1_3.xsd" ` +
      `Version="${VERSION}" RFC="${esc(args.rfc)}" Mes="${mm(args.month)}" Anio="${args.year}" TipoSolicitud="${args.tipoSolicitud}"${identAttr(args.tipoSolicitud, args.numOrden, args.numTramite)}>`,
  ];
  for (const d of args.detalles) {
    lines.push(`  <RepAuxFol:DetAuxFol NumUnIdenPol="${esc(d.numUnIdenPol)}" Fecha="${esc(d.fecha)}">`);
    for (const c of d.comprobantes) {
      lines.push(`    <RepAuxFol:ComprNal UUID_CFDI="${esc(c.uuid)}" RFC="${esc(c.rfc)}" MontoTotal="${money(c.montoTotal)}" />`);
    }
    lines.push(`  </RepAuxFol:DetAuxFol>`);
  }
  lines.push(`</RepAuxFol:RepAuxFol>`);
  return lines.join("\n");
}

// ── Generadores (DB) ─────────────────────────────────────────────────────────

interface AuxOptions {
  companyId: string;
  year: number;
  month: number;
  tipoSolicitud: TipoSolicitud;
  numOrden?: string | null;
  numTramite?: string | null;
}

export async function generateAuxiliarCtasXml(opts: AuxOptions): Promise<string> {
  await assertMesPosteado(opts.companyId, opts.year, opts.month);
  const company = await prisma.company.findUnique({ where: { id: opts.companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");

  const [rows, entries] = await Promise.all([
    balanza(opts.companyId, opts.year, opts.month),
    prisma.accountingEntry.findMany({
      where: { companyId: opts.companyId, year: opts.year, month: opts.month },
      select: {
        fecha: true, descripcion: true, monto: true, tipo: true, referencia: true, referenciaTipo: true, fuente: true,
        chartAccount: { select: { cuentaSAT: true, subcuenta: true } },
      },
      orderBy: { fecha: "asc" },
    }),
  ]);

  const conFecha = entries.map((e) => ({ ...e, monto: Number(e.monto), fechaStr: e.fecha.toISOString().slice(0, 10) }));
  const num = numerarPolizas(
    conFecha.map((e) => ({ referencia: e.referencia, referenciaTipo: e.referenciaTipo, fuente: e.fuente, fecha: e.fechaStr, concepto: e.descripcion })),
  );

  const movPorCuenta = new Map<string, AuxCtaMovimiento[]>();
  for (const e of conFecha) {
    const numCta = e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT;
    const clave = clavePoliza({ referencia: e.referencia, referenciaTipo: e.referenciaTipo, fuente: e.fuente, fecha: e.fechaStr, concepto: e.descripcion });
    const arr = movPorCuenta.get(numCta) ?? [];
    arr.push({
      fecha: e.fechaStr,
      numUnIdenPol: num.get(clave)!,
      concepto: e.descripcion,
      debe: e.tipo === "CARGO" ? e.monto : 0,
      haber: e.tipo === "ABONO" ? e.monto : 0,
    });
    movPorCuenta.set(numCta, arr);
  }

  // Sólo cuentas CON movimientos del periodo: el XSD exige ≥1 DetalleAux por
  // Cuenta, así que una cuenta con puro saldo (sin movimiento) invalida el XML.
  const cuentas: AuxCtaInput[] = rows
    .filter((r) => (movPorCuenta.get(r.subcuenta ?? r.cuentaSAT)?.length ?? 0) > 0)
    .map((r) => {
      const numCta = r.subcuenta ?? r.cuentaSAT;
      return {
        numCta,
        desCta: r.nombre,
        saldoIni: Math.abs(r.saldoInicial),
        saldoFin: Math.abs(r.saldoFinal),
        movimientos: movPorCuenta.get(numCta) ?? [],
      };
    });

  return renderAuxiliarCtasXml({
    rfc: company.rfc, year: opts.year, month: opts.month,
    tipoSolicitud: opts.tipoSolicitud, numOrden: opts.numOrden, numTramite: opts.numTramite, cuentas,
  });
}

export async function generateAuxiliarFoliosXml(opts: AuxOptions): Promise<string> {
  await assertMesPosteado(opts.companyId, opts.year, opts.month);
  const company = await prisma.company.findUnique({ where: { id: opts.companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");

  const entries = await prisma.accountingEntry.findMany({
    where: { companyId: opts.companyId, year: opts.year, month: opts.month, referenciaTipo: "CFDI", referencia: { not: null } },
    select: { fecha: true, descripcion: true, referencia: true, referenciaTipo: true, fuente: true },
    orderBy: { fecha: "asc" },
  });

  const conFecha = entries.map((e) => ({ ...e, fechaStr: e.fecha.toISOString().slice(0, 10) }));
  const num = numerarPolizas(
    conFecha.map((e) => ({ referencia: e.referencia, referenciaTipo: e.referenciaTipo, fuente: e.fuente, fecha: e.fechaStr, concepto: e.descripcion })),
  );

  // CompNal por UUID.
  const uuids = [...new Set(conFecha.map((e) => e.referencia!))];
  const invoices = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId: opts.companyId, uuid: { in: uuids } },
        select: { uuid: true, total: true, tipo: true, rawXml: true, customer: { select: { rfc: true } } },
      })
    : [];
  // Mismo fallback de RFC que las pólizas: sin él, un CFDI recibido sin
  // proveedor ligado desaparecía del auxiliar de folios EN SILENCIO.
  const compNalPorUuid = new Map<string, CompNalInput>();
  for (const inv of invoices) {
    if (!inv.uuid) continue;
    const esRecibido = inv.tipo === "EGRESO" || inv.tipo === "PAGO";
    const rfc = esRecibido
      ? rfcDesdeXml(inv.rawXml, "Emisor") ?? inv.customer?.rfc ?? null
      : inv.customer?.rfc ?? rfcDesdeXml(inv.rawXml, "Receptor");
    if (rfc) compNalPorUuid.set(inv.uuid, { uuid: inv.uuid, rfc, montoTotal: Number(inv.total) });
  }

  // Una entrada DetAuxFol por póliza, con sus comprobantes únicos.
  const porPoliza = new Map<string, { fecha: string; uuids: Set<string> }>();
  for (const e of conFecha) {
    const clave = clavePoliza({ referencia: e.referencia, referenciaTipo: e.referenciaTipo, fuente: e.fuente, fecha: e.fechaStr, concepto: e.descripcion });
    const numId = num.get(clave)!;
    const d = porPoliza.get(numId) ?? { fecha: e.fechaStr, uuids: new Set<string>() };
    if (compNalPorUuid.has(e.referencia!)) d.uuids.add(e.referencia!);
    porPoliza.set(numId, d);
  }

  const detalles: DetAuxFolInput[] = [...porPoliza.entries()]
    .filter(([, d]) => d.uuids.size > 0)
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([numUnIdenPol, d]) => ({
      numUnIdenPol,
      fecha: d.fecha,
      comprobantes: [...d.uuids].map((u) => compNalPorUuid.get(u)!),
    }));

  return renderAuxiliarFoliosXml({
    rfc: company.rfc, year: opts.year, month: opts.month,
    tipoSolicitud: opts.tipoSolicitud, numOrden: opts.numOrden, numTramite: opts.numTramite, detalles,
  });
}
