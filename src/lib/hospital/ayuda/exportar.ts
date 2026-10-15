// ─────────────────────────────────────────────────────────────────────────────
// Excel de lo que la mascota consultó: lotes por caducar, inventario,
// proveedores, clientes, compras por proveedor. El modelo sólo dice QUÉ
// herramienta y con qué parámetros ("exportar"); el hub firma un enlace (24 h)
// y, al abrirlo, vuelve a correr la herramienta SIN los topes del chat, con
// los permisos que el usuario tenga EN ESE MOMENTO, y arma el XLSX.
//
// El enlace va firmado porque HospitalOS habla con Bearer y un <a href> no lo
// manda (igual que el reporte de facturas).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { PAGINAS_HERRAMIENTA } from "./herramientas";

const TTL_MS = 24 * 60 * 60 * 1000;
function secreto(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET no configurada para firmar descargas");
  return s;
}

/** Las herramientas que dan una lista que vale la pena bajar. */
export const EXPORTABLES = Object.keys(PAGINAS_HERRAMIENTA);

export interface Exportacion {
  companyId: string;
  userId: string;
  herramienta: string;
  parametros: Record<string, unknown>;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const deB64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const firma = (carga: string, exp: number) => crypto.createHmac("sha256", secreto()).update(`ayuda-exportar.${carga}.${exp}`).digest("base64url");

/** «?d=…&t=exp.firma» para GET /api/hospital/ayuda/exportar. */
export function firmarExportacion(e: Exportacion, ahora = Date.now()): string {
  const carga = b64(JSON.stringify([e.companyId, e.userId, e.herramienta, e.parametros]));
  const exp = ahora + TTL_MS;
  return new URLSearchParams({ d: carga, t: `${exp}.${firma(carga, exp)}` }).toString();
}

/** La exportación del enlace, o null si la firma no cuadra o ya venció. */
export function leerExportacion(d: string | null, t: string | null, ahora = Date.now()): Exportacion | null {
  if (!d || !t) return null;
  const [expStr, sig] = t.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || ahora > exp) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(firma(d, exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const [companyId, userId, herramienta, parametros] = JSON.parse(deB64(d));
    if (typeof companyId !== "string" || typeof userId !== "string" || !EXPORTABLES.includes(herramienta)) return null;
    return { companyId, userId, herramienta, parametros: parametros && typeof parametros === "object" ? parametros : {} };
  } catch {
    return null;
  }
}

/** Lo que pidió el modelo, validado: una herramienta exportable y parámetros planos. */
export function exportacionDelModelo(x: unknown): { herramienta: string; parametros: Record<string, unknown> } | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.herramienta !== "string" || !EXPORTABLES.includes(o.herramienta)) return null;
  const p = o.parametros && typeof o.parametros === "object" && !Array.isArray(o.parametros) ? (o.parametros as Record<string, unknown>) : {};
  const parametros = Object.fromEntries(Object.entries(p).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 6));
  return { herramienta: o.herramienta, parametros };
}

// ── Del resultado de la herramienta a hojas ─────────────────────────────────

const TITULOS: Record<string, string> = {
  clave: "Clave", nombre: "Nombre", presentacion: "Presentación", unidad: "Unidad", existencia: "Existencia", minimo: "Mínimo",
  bajoMinimo: "Bajo mínimo", precioVenta: "Precio de venta", ultimoCosto: "Último costo", lote: "Lote", caducidad: "Caducidad",
  caducado: "Caducado", bloqueado: "Bloqueado", proveedor: "Proveedor", diasParaCaducar: "Días para caducar", razonSocial: "Razón social",
  rfc: "RFC", correo: "Correo", credito: "Crédito", requisiciones: "Requisiciones", regimenFiscal: "Régimen fiscal", facturas: "Facturas",
  totalConIva: "Total con IVA", ordenes: "Órdenes", total: "Total", cantidad: "Cantidad", monto: "Monto",
};
const HOJAS: Record<string, string> = {
  lotes: "Lotes", insumos: "Inventario", proveedores: "Proveedores", clientes: "Clientes",
  "facturasRecibidas.porProveedor": "Facturas recibidas", ordenesAutorizadas: "Órdenes autorizadas", insumosRecibidos: "Insumos recibidos",
};
const titulo = (k: string) => TITULOS[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const escalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const valor = (v: unknown) => (typeof v === "boolean" ? (v ? "Sí" : "No") : v);
const esFilas = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));

/** Una fila por elemento; si trae una lista adentro (insumo → lotes), una fila por cada uno con los datos del padre. */
function filasDe(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const it of items) {
    const base = Object.fromEntries(Object.entries(it).filter(([, v]) => escalar(v)).map(([k, v]) => [titulo(k), valor(v)]));
    const hija = Object.entries(it).find(([, v]) => esFilas(v));
    if (!hija) { out.push(base); continue }
    for (const h of hija[1] as Record<string, unknown>[]) {
      out.push({ ...base, ...Object.fromEntries(Object.entries(h).filter(([, v]) => escalar(v)).map(([k, v]) => [titulo(k), valor(v)])) });
    }
  }
  return out;
}

/** Cada lista del resultado (también una dentro de un objeto) → una hoja. */
export function hojasDeResultado(r: Record<string, unknown>): Array<{ nombre: string; filas: Record<string, unknown>[] }> {
  const hojas: Array<{ nombre: string; filas: Record<string, unknown>[] }> = [];
  for (const [k, v] of Object.entries(r)) {
    if (esFilas(v)) hojas.push({ nombre: HOJAS[k] ?? titulo(k), filas: filasDe(v) });
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (esFilas(v2)) hojas.push({ nombre: HOJAS[`${k}.${k2}`] ?? titulo(k2), filas: filasDe(v2) });
    }
  }
  return hojas;
}

export const NOMBRE_ARCHIVO: Record<string, string> = {
  consultar_inventario: "inventario", insumos_por_caducar: "lotes-por-caducar", buscar_proveedores: "proveedores",
  buscar_clientes: "clientes", compras_por_proveedor: "compras-por-proveedor",
};

/** XLSX con una hoja por lista (o una que dice que no hubo nada). */
export function xlsxDeResultado(r: Record<string, unknown>): Buffer {
  const wb = XLSX.utils.book_new();
  const hojas = hojasDeResultado(r);
  if (!hojas.length || hojas.every((h) => !h.filas.length)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Sin resultados"]]), "Resultado");
  }
  for (const h of hojas) {
    const ws = XLSX.utils.json_to_sheet(h.filas);
    const cols = Object.keys(h.filas[0] ?? {});
    ws["!cols"] = cols.map((c) => ({ wch: Math.min(48, Math.max(c.length, ...h.filas.slice(0, 200).map((f) => String(f[c] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, h.nombre.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
