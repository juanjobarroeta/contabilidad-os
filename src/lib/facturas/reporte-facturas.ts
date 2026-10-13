// ─────────────────────────────────────────────────────────────────────────────
// REPORTE DE FACTURAS A PEDIDO (Mochi).
//
// «Las facturas del cliente X de enero a marzo», «lo que nos facturó Pisa este
// año», «las facturas pendientes de cobro de A y B»: el usuario lo pide en el
// chat y recibe un resumen y dos archivos — un Excel con renglón por CFDI y un
// ZIP con los XML. Lo que el modelo decide son los FILTROS; las cifras salen
// siempre de esta consulta, nunca del modelo.
//
// Pagado/saldo con la misma regla que el perfil del contacto: PUE se considera
// liquidada al emitirse; PPD por la mejor evidencia (REP vigente o
// conciliación bancaria).
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { amparadoPorReps, amparadoDe, pagadoPorEvidencia } from "@/lib/hospital/cobranza";

type Db = PrismaClient | Prisma.TransactionClient;

/** Más renglones que esto no caben en una respuesta útil; se pide acotar. */
export const MAX_RENGLONES = 5000;
/** Un ZIP con más XML que esto se vuelve una descarga frágil; se pide acotar. */
export const MAX_ZIP = 2000;

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD");
export const filtrosSchema = z
  .object({
    contrapartes: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
    desde: dia.optional(),
    hasta: dia.optional(),
    direccion: z.enum(["EMITIDAS", "RECIBIDAS", "AMBAS"]).default("AMBAS"),
    tipos: z.array(z.enum(["I", "E", "P", "N"])).max(4).optional(),
    estado: z.enum(["VIGENTES", "CANCELADAS", "TODAS"]).default("VIGENTES"),
    metodoPago: z.enum(["PUE", "PPD"]).optional(),
    saldo: z.enum(["PAGADAS", "PENDIENTES", "TODAS"]).default("TODAS"),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.desde && f.hasta && f.desde > f.hasta) ctx.addIssue({ code: "custom", message: "La fecha inicial es posterior a la final." });
  });
export type FiltrosReporte = z.infer<typeof filtrosSchema>;

export interface ContraparteResuelta {
  termino: string;
  customerIds: string[];
  nombre: string | null;
}
export interface Ambiguedad {
  termino: string;
  candidatos: { id: string; razonSocial: string; rfc: string }[];
}

const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[.,]/g, " ")
    .replace(/\b(S\s*A\s*P?\s*I?\s*(DE\s*)?C\s*V|S\s*DE\s*R\s*L(\s*DE\s*C\s*V)?|S\s*C|A\s*C)\b/g, " ")
    .replace(/\s+/g, " ").trim();

/**
 * Cada término (nombre o RFC) a sus contactos. Un RFC o un nombre exacto
 * resuelve solo; varios parecidos sin uno exacto es una ambigüedad que se le
 * pregunta al usuario — no se escoge por él.
 */
export async function resolverContrapartes(db: Db, companyId: string, terminos: string[]) {
  const resueltas: ContraparteResuelta[] = [];
  const ambiguas: Ambiguedad[] = [];
  const noEncontradas: string[] = [];
  for (const t of terminos) {
    const limpio = t.trim();
    if (RFC.test(limpio.replace(/\s/g, ""))) {
      const rfc = limpio.replace(/\s/g, "").toUpperCase();
      const cs = await db.customer.findMany({ where: { companyId, rfc: { equals: rfc, mode: "insensitive" } }, select: { id: true, razonSocial: true } });
      if (cs.length) resueltas.push({ termino: t, customerIds: cs.map((c) => c.id), nombre: cs[0].razonSocial });
      else noEncontradas.push(t);
      continue;
    }
    const n = norm(limpio);
    const palabras = n.split(" ").filter((w) => w.length >= 3);
    if (!palabras.length) { noEncontradas.push(t); continue; }
    const cs = await db.customer.findMany({
      where: { companyId, AND: palabras.map((w) => ({ razonSocial: { contains: w, mode: "insensitive" as const } })) },
      select: { id: true, razonSocial: true, rfc: true },
      take: 25,
    });
    if (cs.length === 0) { noEncontradas.push(t); continue; }
    const exactos = cs.filter((c) => norm(c.razonSocial) === n);
    const elegidos = exactos.length ? exactos : cs.length === 1 ? cs : [];
    // El mismo RFC repetido en varios contactos es UNA contraparte.
    const rfcs = new Set(cs.map((c) => c.rfc.toUpperCase()));
    if (elegidos.length) resueltas.push({ termino: t, customerIds: elegidos.map((c) => c.id), nombre: elegidos[0].razonSocial });
    else if (rfcs.size === 1) resueltas.push({ termino: t, customerIds: cs.map((c) => c.id), nombre: cs[0].razonSocial });
    else ambiguas.push({ termino: t, candidatos: cs.slice(0, 8).map((c) => ({ id: c.id, razonSocial: c.razonSocial, rfc: c.rfc })) });
  }
  return { resueltas, ambiguas, noEncontradas };
}

export interface RenglonReporte {
  id: string;
  fecha: string;
  serieFolio: string;
  uuid: string | null;
  direccion: "EMITIDA" | "RECIBIDA";
  tipo: string;
  emisor: string;
  receptor: string;
  contraparte: string;
  contraparteRfc: string;
  subtotal: number;
  descuento: number;
  iva: number;
  retenciones: number;
  total: number;
  moneda: string;
  metodoPago: string | null;
  estado: string;
  pagado: number;
  saldo: number;
  tieneXml: boolean;
}

export interface ResumenReporte {
  facturas: number;
  subtotal: number;
  descuento: number;
  iva: number;
  retenciones: number;
  total: number;
  pagado: number;
  saldo: number;
  porContraparte: { contraparte: string; rfc: string; facturas: number; total: number; saldo: number }[];
  sinXml: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const tipoDe = (tipo: string, tipoSat: string | null) =>
  tipoSat === "E" ? "E" : tipo === "PAGO" || tipoSat === "P" ? "P" : tipo === "NOMINA" || tipoSat === "N" ? "N" : "I";
const NOMBRE_TIPO: Record<string, string> = { I: "Ingreso", E: "Nota de crédito", P: "Complemento de pago", N: "Nómina" };

/** El `where` de Prisma a partir de los filtros ya validados. PURA. */
export function whereDeFiltros(companyId: string, f: FiltrosReporte, customerIds: string[] | null): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId }];
  if (customerIds) and.push({ customerId: { in: customerIds } });
  if (f.desde || f.hasta) and.push({ fecha: { ...(f.desde ? { gte: new Date(`${f.desde}T00:00:00Z`) } : {}), ...(f.hasta ? { lte: new Date(`${f.hasta}T23:59:59.999Z`) } : {}) } });
  // Un REP no dice en su fila si es emitido o recibido: entra en ambos y se
  // separa después por el RFC del emisor en su XML (consultarReporte).
  if (f.direccion === "EMITIDAS") and.push({ tipo: { in: ["INGRESO", "PAGO", "NOMINA"] } });
  if (f.direccion === "RECIBIDAS") and.push({ tipo: { in: ["EGRESO", "PAGO"] } });
  if (f.estado === "VIGENTES") and.push({ status: "STAMPED" });
  else if (f.estado === "CANCELADAS") and.push({ status: "CANCELLED" });
  else and.push({ status: { in: ["STAMPED", "CANCELLED"] } });
  if (f.metodoPago) and.push({ metodoPago: f.metodoPago });
  if (f.tipos?.length) {
    const or: Prisma.InvoiceWhereInput[] = [];
    if (f.tipos.includes("I")) or.push({ tipo: { in: ["INGRESO", "EGRESO"] }, OR: [{ tipoSat: null }, { tipoSat: "I" }] });
    if (f.tipos.includes("E")) or.push({ tipoSat: "E" });
    if (f.tipos.includes("P")) or.push({ OR: [{ tipo: "PAGO" }, { tipoSat: "P" }] });
    if (f.tipos.includes("N")) or.push({ OR: [{ tipo: "NOMINA" }, { tipoSat: "N" }] });
    and.push({ OR: or });
  }
  return { AND: and };
}

/** Totales y desglose por contraparte. PURA. */
export function resumir(rows: RenglonReporte[]): ResumenReporte {
  const vigentes = rows.filter((r) => r.estado !== "CANCELLED");
  const signo = (r: RenglonReporte) => (r.tipo === NOMBRE_TIPO.E ? -1 : 1);
  const suma = (k: keyof Pick<RenglonReporte, "subtotal" | "descuento" | "iva" | "retenciones" | "total" | "pagado" | "saldo">) =>
    r2(vigentes.reduce((s, r) => s + signo(r) * r[k], 0));
  const por = new Map<string, ResumenReporte["porContraparte"][number]>();
  for (const r of vigentes) {
    const k = r.contraparteRfc || r.contraparte;
    const x = por.get(k) ?? { contraparte: r.contraparte, rfc: r.contraparteRfc, facturas: 0, total: 0, saldo: 0 };
    x.facturas += 1;
    x.total = r2(x.total + signo(r) * r.total);
    x.saldo = r2(x.saldo + signo(r) * r.saldo);
    por.set(k, x);
  }
  return {
    facturas: rows.length,
    subtotal: suma("subtotal"),
    descuento: suma("descuento"),
    iva: suma("iva"),
    retenciones: suma("retenciones"),
    total: suma("total"),
    pagado: suma("pagado"),
    saldo: suma("saldo"),
    porContraparte: [...por.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    sinXml: rows.filter((r) => !r.tieneXml).length,
  };
}

/** Corre el reporte. Devuelve los renglones (acotados) y si se cortó. */
export async function consultarReporte(db: Db, companyId: string, filtros: FiltrosReporte, customerIds: string[] | null) {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { razonSocial: true, rfc: true } });
  if (!company) throw new Error("Empresa no encontrada.");
  const facturas = await db.invoice.findMany({
    where: whereDeFiltros(companyId, filtros, customerIds),
    orderBy: [{ fecha: "asc" }, { id: "asc" }],
    take: MAX_RENGLONES + 1,
    select: {
      id: true, fecha: true, serie: true, folio: true, uuid: true, tipo: true, tipoSat: true, status: true, metodoPago: true,
      subtotal: true, descuento: true, total: true, moneda: true, contraparteNombre: true, contraparteRfc: true, cfdiRelacionadoUuid: true,
      customer: { select: { razonSocial: true, rfc: true } },
      taxes: { select: { tipo: true, retencion: true, importe: true } },
      conciliacionDetalles: { select: { montoAsignado: true } },
      bankTransactions: { where: { status: "MATCHED" }, select: { monto: true } },
    },
  });
  const cortado = facturas.length > MAX_RENGLONES;
  const lista = facturas.slice(0, MAX_RENGLONES);
  const conXml = new Set(
    (await db.invoice.findMany({ where: { id: { in: lista.map((f) => f.id) }, rawXml: { not: null } }, select: { id: true } })).map((x) => x.id),
  );
  const amparado = await amparadoPorReps(db as PrismaClient, companyId, lista.map((f) => f.uuid));
  // Dirección de los REPs: el RFC del emisor en su XML.
  const pagos = lista.filter((f) => f.tipo === "PAGO").map((f) => f.id);
  const repRecibido = new Set<string>();
  for (let i = 0; i < pagos.length; i += 200) {
    const xs = await db.invoice.findMany({ where: { id: { in: pagos.slice(i, i + 200) } }, select: { id: true, rawXml: true } });
    for (const x of xs) {
      const emisor = /<(?:[\w-]+:)?Emisor\b[^>]*\bRfc="([^"]+)"/i.exec(x.rawXml ?? "")?.[1];
      if (emisor && emisor.toUpperCase() !== company.rfc.toUpperCase()) repRecibido.add(x.id);
    }
  }
  const rows: RenglonReporte[] = lista.map((f) => {
    const t = tipoDe(f.tipo, f.tipoSat);
    const recibida = f.tipo === "EGRESO" || (f.tipo === "PAGO" && repRecibido.has(f.id));
    const contraparte = f.customer?.razonSocial ?? f.contraparteNombre ?? "—";
    const contraparteRfc = f.customer?.rfc ?? f.contraparteRfc ?? "";
    const total = Number(f.total);
    const conciliado = r2(
      f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0) +
        f.bankTransactions.reduce((s, b) => s + Math.abs(Number(b.monto)), 0),
    );
    const ev = t === "I" ? pagadoPorEvidencia({ metodoPago: f.metodoPago, total, conciliado, amparadoRep: amparadoDe(amparado, f.uuid) }) : { pagado: 0, saldo: 0 };
    return {
      id: f.id,
      fecha: f.fecha.toISOString().slice(0, 10),
      serieFolio: [f.serie, f.folio].filter(Boolean).join("-"),
      uuid: f.uuid,
      direccion: recibida ? "RECIBIDA" : "EMITIDA",
      tipo: NOMBRE_TIPO[t],
      emisor: recibida ? contraparte : company.razonSocial,
      receptor: recibida ? company.razonSocial : contraparte,
      contraparte,
      contraparteRfc,
      subtotal: Number(f.subtotal),
      descuento: Number(f.descuento),
      iva: r2(f.taxes.filter((x) => x.tipo === "IVA" && !x.retencion).reduce((s, x) => s + Number(x.importe), 0)),
      retenciones: r2(f.taxes.filter((x) => x.retencion).reduce((s, x) => s + Number(x.importe), 0)),
      total,
      moneda: f.moneda,
      metodoPago: f.metodoPago,
      estado: f.status,
      pagado: ev.pagado,
      saldo: ev.saldo,
      tieneXml: conXml.has(f.id),
    };
  });
  // Una nota de crédito baja el saldo de la factura que relaciona (si está en
  // el reporte), como en el perfil del contacto: el saldo es lo que se debe hoy.
  const porUuid = new Map(rows.filter((r) => r.uuid && r.tipo === NOMBRE_TIPO.I).map((r) => [r.uuid!.toUpperCase(), r]));
  for (const f of lista) {
    if (f.tipoSat !== "E" || f.status !== "STAMPED" || !f.cfdiRelacionadoUuid) continue;
    const padre = porUuid.get(f.cfdiRelacionadoUuid.toUpperCase());
    if (!padre || padre.metodoPago !== "PPD") continue;
    const aplica = Math.min(padre.saldo, Number(f.total));
    padre.saldo = r2(padre.saldo - aplica);
  }
  const porDireccion = rows.filter((r) =>
    filtros.direccion === "AMBAS" || (filtros.direccion === "EMITIDAS" ? r.direccion === "EMITIDA" : r.direccion === "RECIBIDA"));
  const filtradas = filtros.saldo === "TODAS"
    ? porDireccion
    : porDireccion.filter((r) => (filtros.saldo === "PENDIENTES" ? r.saldo > 0.01 : r.saldo <= 0.01 && r.tipo === NOMBRE_TIPO.I));
  return { company, rows: filtradas, cortado };
}

/** Excel: una hoja de detalle y una de resumen por contraparte. */
export function construirXlsx(rows: RenglonReporte[], resumen: ResumenReporte, titulo: string): Buffer {
  const wb = XLSX.utils.book_new();
  const detalle = rows.map((r) => ({
    Fecha: r.fecha, "Serie-Folio": r.serieFolio, UUID: r.uuid ?? "", Tipo: r.tipo, Dirección: r.direccion === "EMITIDA" ? "Emitida" : "Recibida",
    Emisor: r.emisor, Receptor: r.receptor, "RFC contraparte": r.contraparteRfc, Subtotal: r.subtotal, Descuento: r.descuento, IVA: r.iva,
    Retenciones: r.retenciones, Total: r.total, Moneda: r.moneda, Método: r.metodoPago ?? "", Estado: r.estado === "CANCELLED" ? "Cancelada" : "Vigente",
    Pagado: r.pagado, Saldo: r.saldo,
  }));
  const ws = XLSX.utils.json_to_sheet(detalle);
  ws["!cols"] = [10, 14, 38, 18, 10, 40, 40, 15, 13, 11, 12, 12, 13, 7, 7, 10, 13, 13].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "Facturas");
  const res = XLSX.utils.json_to_sheet([
    ...resumen.porContraparte.map((p) => ({ Contraparte: p.contraparte, RFC: p.rfc, Facturas: p.facturas, Total: p.total, Saldo: p.saldo })),
    { Contraparte: "TOTAL", RFC: "", Facturas: resumen.facturas, Total: resumen.total, Saldo: resumen.saldo },
  ]);
  res["!cols"] = [44, 15, 10, 15, 15].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, res, "Resumen");
  wb.Props = { Title: titulo };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** ZIP con el XML de cada CFDI (sólo los que tienen XML guardado). */
export async function construirZip(db: Db, companyId: string, rows: RenglonReporte[]): Promise<{ buffer: Buffer; incluidos: number; sinXml: number }> {
  if (rows.length > MAX_ZIP) throw new Error(`Son ${rows.length} CFDIs; el ZIP admite hasta ${MAX_ZIP}. Acota el periodo o las contrapartes.`);
  const zip = new JSZip();
  let incluidos = 0;
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const lote = await db.invoice.findMany({ where: { companyId, id: { in: ids.slice(i, i + 200) }, rawXml: { not: null } }, select: { id: true, uuid: true, serie: true, folio: true, fecha: true, rawXml: true } });
    for (const f of lote) {
      const nombre = `${f.fecha.toISOString().slice(0, 10)}_${[f.serie, f.folio].filter(Boolean).join("-") || "sin-folio"}_${(f.uuid ?? f.id).slice(0, 8)}`.replace(/[^\w.-]/g, "_");
      zip.file(`${nombre}.xml`, f.rawXml as string);
      incluidos++;
    }
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, incluidos, sinXml: rows.length - incluidos };
}

/** «Facturas de X · 2026-01-01 a 2026-09-30» para títulos y nombres de archivo. */
export function tituloReporte(f: FiltrosReporte, nombres: string[]): string {
  const quien = nombres.length ? nombres.slice(0, 3).join(", ") + (nombres.length > 3 ? ` y ${nombres.length - 3} más` : "") : "todas las contrapartes";
  const dir = f.direccion === "EMITIDAS" ? "emitidas" : f.direccion === "RECIBIDAS" ? "recibidas" : "";
  const periodo = f.desde || f.hasta ? ` · ${f.desde ?? "inicio"} a ${f.hasta ?? "hoy"}` : "";
  return `Facturas ${dir} de ${quien}${periodo}`.replace(/\s+/g, " ").trim();
}
