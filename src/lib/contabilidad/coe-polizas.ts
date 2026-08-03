// ─────────────────────────────────────────────────────────────────────────────
// COE M5 — Pólizas del Periodo (PolizasPeriodo_1_3.xsd).
//
// Se entrega a solicitud del SAT (auditoría AF/FC, devolución DE, compensación
// CO). Agrupa los asientos del periodo en pólizas; cada transacción CFDI lleva
// su CompNal (UUID + RFC del tercero + monto). render* es PURO (validable contra
// el XSD); generate* lee la base.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";

const VERSION = "1.3";
const esc = (s: string | null | undefined): string =>
  s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const money = (n: number): string => n.toFixed(2);
const mm = (m: number): string => String(m).padStart(2, "0");

export type TipoSolicitud = "AF" | "FC" | "DE" | "CO";

export interface CompNalInput {
  uuid: string;
  rfc: string;
  montoTotal: number;
}
export interface TransaccionInput {
  numCta: string;
  desCta?: string;
  concepto: string;
  debe: number;
  haber: number;
  compNal?: CompNalInput;
}
export interface PolizaInput {
  numUnIdenPol: string;
  fecha: string; // YYYY-MM-DD
  concepto: string;
  transacciones: TransaccionInput[];
}

/** Render puro de Pólizas del Periodo. */
export function renderPolizasXml(args: {
  rfc: string;
  year: number;
  month: number;
  tipoSolicitud: TipoSolicitud;
  numOrden?: string | null;
  numTramite?: string | null;
  polizas: PolizaInput[];
}): string {
  // NumOrden aplica a AF/FC; NumTramite a DE/CO.
  const ident =
    (args.tipoSolicitud === "AF" || args.tipoSolicitud === "FC")
      ? (args.numOrden ? ` NumOrden="${esc(args.numOrden)}"` : "")
      : (args.numTramite ? ` NumTramite="${esc(args.numTramite)}"` : "");

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<PLZ:Polizas xmlns:PLZ="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd" ` +
      `Version="${VERSION}" RFC="${esc(args.rfc)}" Mes="${mm(args.month)}" Anio="${args.year}" TipoSolicitud="${args.tipoSolicitud}"${ident}>`,
  ];
  for (const p of args.polizas) {
    lines.push(`  <PLZ:Poliza NumUnIdenPol="${esc(p.numUnIdenPol)}" Fecha="${esc(p.fecha)}" Concepto="${esc(p.concepto)}">`);
    for (const t of p.transacciones) {
      const desCta = t.desCta ? ` DesCta="${esc(t.desCta)}"` : "";
      const open = `    <PLZ:Transaccion NumCta="${esc(t.numCta)}"${desCta} Concepto="${esc(t.concepto)}" Debe="${money(t.debe)}" Haber="${money(t.haber)}"`;
      if (t.compNal) {
        lines.push(`${open}>`);
        lines.push(`      <PLZ:CompNal UUID_CFDI="${esc(t.compNal.uuid)}" RFC="${esc(t.compNal.rfc)}" MontoTotal="${money(t.compNal.montoTotal)}" />`);
        lines.push(`    </PLZ:Transaccion>`);
      } else {
        lines.push(`${open} />`);
      }
    }
    lines.push(`  </PLZ:Poliza>`);
  }
  lines.push(`</PLZ:Polizas>`);
  return lines.join("\n");
}

export interface EntryForPoliza {
  numCta: string;
  desCta: string;
  concepto: string;
  tipo: "CARGO" | "ABONO";
  monto: number;
  fecha: string; // YYYY-MM-DD
  referencia: string | null;
  referenciaTipo: string | null;
  fuente: string;
  compNal?: CompNalInput;
}

/**
 * Clave de agrupación de una póliza: por documento (referencia) o, sin
 * referencia, por fuente+fecha+concepto. Compartida por pólizas y auxiliares
 * para que el NumUnIdenPol coincida entre reportes.
 */
export function clavePoliza(e: {
  referencia: string | null;
  referenciaTipo: string | null;
  fuente: string;
  fecha: string;
  concepto: string;
}): string {
  return e.referencia ? `${e.referenciaTipo}:${e.referencia}` : `${e.fuente}:${e.fecha}:${e.concepto}`;
}

/** Mapa clave-de-póliza → NumUnIdenPol consecutivo (ordenado por fecha, luego clave). */
export function numerarPolizas(
  entries: { referencia: string | null; referenciaTipo: string | null; fuente: string; fecha: string; concepto: string }[],
): Map<string, string> {
  const primeraFecha = new Map<string, string>();
  for (const e of entries) {
    const k = clavePoliza(e);
    if (!primeraFecha.has(k)) primeraFecha.set(k, e.fecha);
  }
  const claves = [...primeraFecha.keys()].sort((a, b) => {
    const fa = primeraFecha.get(a)!;
    const fb = primeraFecha.get(b)!;
    return fa === fb ? a.localeCompare(b) : fa.localeCompare(fb);
  });
  return new Map(claves.map((k, i) => [k, String(i + 1)]));
}

/**
 * Agrupa asientos en pólizas: una póliza por documento (referencia) o, sin
 * referencia, por (fuente + fecha + concepto). NumUnIdenPol = consecutivo
 * estable (ordenado por fecha y clave).
 */
export function agruparPolizas(entries: EntryForPoliza[]): PolizaInput[] {
  const num = numerarPolizas(entries);
  const grupos = new Map<string, EntryForPoliza[]>();
  for (const e of entries) {
    const clave = clavePoliza(e);
    const arr = grupos.get(clave) ?? [];
    arr.push(e);
    grupos.set(clave, arr);
  }
  const claves = [...grupos.keys()].sort((a, b) => (num.get(a)! ).localeCompare(num.get(b)!, undefined, { numeric: true }));
  return claves.map((clave) => {
    const items = grupos.get(clave)!;
    return {
      numUnIdenPol: num.get(clave)!,
      fecha: items[0].fecha,
      concepto: items[0].concepto || "Asiento contable",
      transacciones: items.map((e) => ({
        numCta: e.numCta,
        desCta: e.desCta,
        concepto: e.concepto || "Movimiento",
        debe: e.tipo === "CARGO" ? e.monto : 0,
        haber: e.tipo === "ABONO" ? e.monto : 0,
        compNal: e.compNal,
      })),
    };
  });
}

export interface PolizasXmlOptions {
  companyId: string;
  year: number;
  month: number;
  tipoSolicitud: TipoSolicitud;
  numOrden?: string | null;
  numTramite?: string | null;
}

export async function generatePolizasXml(opts: PolizasXmlOptions): Promise<string> {
  const company = await prisma.company.findUnique({ where: { id: opts.companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");

  const entries = await prisma.accountingEntry.findMany({
    where: { companyId: opts.companyId, year: opts.year, month: opts.month },
    select: {
      fecha: true, descripcion: true, monto: true, tipo: true, referencia: true, referenciaTipo: true, fuente: true,
      chartAccount: { select: { cuentaSAT: true, subcuenta: true, nombre: true } },
    },
    orderBy: { fecha: "asc" },
  });

  // CompNal: resuelve los CFDIs referenciados (UUID → RFC del tercero + total).
  // El RFC del tercero depende de la dirección del CFDI: en un EGRESO/PAGO
  // recibido el tercero es el EMISOR; en INGRESO/NOMINA emitidos, el RECEPTOR.
  // La relación `customer` puede faltar (CFDIs recibidos de la descarga masiva
  // sin proveedor ligado) — sin fallback, la póliza salía SIN el nodo CompNal
  // obligatorio. Fallback: el RFC leído del propio rawXml guardado.
  const uuids = [...new Set(entries.filter((e) => e.referenciaTipo === "CFDI" && e.referencia).map((e) => e.referencia!))];
  const invoices = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId: opts.companyId, uuid: { in: uuids } },
        select: { uuid: true, total: true, tipo: true, rawXml: true, customer: { select: { rfc: true } } },
      })
    : [];
  const rfcDesdeXml = (xml: string | null, nodo: "Emisor" | "Receptor"): string | null => {
    if (!xml) return null;
    const m = new RegExp(`<(?:[a-zA-Z0-9]+:)?${nodo}\\b[^>]*\\bRfc="([^"]+)"`).exec(xml);
    return m?.[1] ?? null;
  };
  const compNalPorUuid = new Map<string, CompNalInput>();
  for (const inv of invoices) {
    if (!inv.uuid) continue;
    const esRecibido = inv.tipo === "EGRESO" || inv.tipo === "PAGO";
    const rfc = esRecibido
      ? rfcDesdeXml(inv.rawXml, "Emisor") ?? inv.customer?.rfc ?? null
      : inv.customer?.rfc ?? rfcDesdeXml(inv.rawXml, "Receptor");
    if (rfc) {
      compNalPorUuid.set(inv.uuid, { uuid: inv.uuid, rfc, montoTotal: inv.total });
    }
  }

  const forPoliza: EntryForPoliza[] = entries.map((e) => ({
    numCta: e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT,
    desCta: e.chartAccount.nombre,
    concepto: e.descripcion,
    tipo: e.tipo as "CARGO" | "ABONO",
    monto: e.monto,
    fecha: e.fecha.toISOString().slice(0, 10),
    referencia: e.referencia,
    referenciaTipo: e.referenciaTipo,
    fuente: e.fuente,
    compNal: e.referenciaTipo === "CFDI" && e.referencia ? compNalPorUuid.get(e.referencia) : undefined,
  }));

  return renderPolizasXml({
    rfc: company.rfc,
    year: opts.year,
    month: opts.month,
    tipoSolicitud: opts.tipoSolicitud,
    numOrden: opts.numOrden,
    numTramite: opts.numTramite,
    polizas: agruparPolizas(forPoliza),
  });
}
