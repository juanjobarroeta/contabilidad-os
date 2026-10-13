// ─────────────────────────────────────────────────────────────────────────────
// Tablas de cotización del hospital (Excel, una hoja por procedimiento) →
// protocolos.
//
// Cada hoja trae el título («PROCEDIMIENTO: …» o «CIRUGIA: …»), secciones
// (QUIRÓFANO, INSUMOS, MEDICAMENTOS, HOSPITALIZACION, LABORATORIO…) con
// encabezado DESCRIPCIÓN | CANTIDAD | PRECIO | IMPORTE, subtotales sueltos en
// columnas de la derecha, «TOTAL C/IVA» y a veces «PAQUETE» con el precio
// pactado. Se lee por encabezado, no por posición: las hojas no empiezan en la
// misma columna.
//
// Cada renglón se empareja con el tarifario (mismo emparejamiento que la
// lectura de cotizaciones de otros hospitales). Con servicio, el precio sale
// del tarifario; sin él se guarda el de la hoja como precio de referencia.
// Todo es puro salvo `hojasDeArchivo` (xlsx).
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import type { HospCargoCategoria } from "@prisma/client";
import { emparejar, normalizar, type Indice } from "./cotizacion-competencia";
import { r2 } from "./util";

export type Celda = string | number | null;
export interface Hoja {
  nombre: string;
  filas: Celda[][];
}

export interface RenglonTabla {
  descripcion: string;
  cantidad: number;
  precio: number | null;
  seccion: string | null;
  categoria: HospCargoCategoria;
}

export interface TablaProtocolo {
  hoja: string;
  clave: string;
  nombre: string;
  renglones: RenglonTabla[];
  totalConIva: number | null;
  precioPaquete: number | null;
  tipoEpisodio: "AMBULATORIO" | "HOSPITALIZACION";
  estanciaNoches: number;
  quirofanoMinutos: number | null;
  avisos: string[];
}

/** Libro → hojas con sus celdas tal cual (números como número). */
export function hojasDeArchivo(buffer: Buffer): Hoja[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  return wb.SheetNames.map((nombre) => ({
    nombre,
    filas: XLSX.utils.sheet_to_json<Celda[]>(wb.Sheets[nombre], { header: 1, raw: true, defval: null, blankrows: false }),
  }));
}

const texto = (v: Celda): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const numero = (v: Celda): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clave = (v: Celda) => normalizar(texto(v));

/** Sección de la hoja → categoría del cargo. */
export function categoriaDeSeccion(seccion: string | null): HospCargoCategoria {
  const s = normalizar(seccion ?? "");
  if (/QUIROFANO|CIRUGIA|SALA/.test(s)) return "QUIROFANO";
  if (/INSUMO|MATERIAL/.test(s)) return "MATERIAL";
  if (/MEDICAMENTO|FARMACIA|SOLUCION/.test(s)) return "FARMACIA";
  if (/HOSPITALIZACION|HABITACION|ESTANCIA/.test(s)) return "HABITACION";
  if (/LABORATORIO|ESTUDIO|IMAGEN|GABINETE/.test(s)) return "ESTUDIO";
  if (/HONORARIO/.test(s)) return "HONORARIO";
  return "QUIROFANO";
}

/** «PROCEDIMIENTO: RINOPLASTIA PRIMARIA» → «Rinoplastia primaria». */
const enOracion = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const claveDeHoja = (hoja: string) =>
  normalizar(hoja).replace(/\s+/g, "-").replace(/[^A-ZÑ0-9.-]/g, "").slice(0, 40) || "PROTOCOLO";

export function leerHoja(h: Hoja): TablaProtocolo {
  const avisos: string[] = [];
  let nombre: string | null = null;
  let col: { desc: number; cant: number; precio: number | null } | null = null;
  let seccion: string | null = null;
  let totalConIva: number | null = null;
  let precioPaquete: number | null = null;
  let cerrada = false;
  const renglones: RenglonTabla[] = [];

  for (const fila of h.filas) {
    const celdas = fila ?? [];
    // Título.
    for (const c of celdas) {
      const m = /^(?:PROCEDIMIENTO|CIRUG[IÍ]A)\s*:\s*(.+)$/i.exec(texto(c));
      if (m && !nombre) nombre = enOracion(m[1]);
    }
    // Totales y paquete: una etiqueta y el primer número a su derecha.
    celdas.forEach((c, i) => {
      const k = clave(c);
      const despues = celdas.slice(i + 1).map(numero).find((n) => n != null) ?? null;
      if (/^TOTAL (C|CON) IVA/.test(k) && despues != null && totalConIva == null) totalConIva = r2(despues);
      if (/^PAQUETE$/.test(k) && despues != null) precioPaquete = r2(despues);
    });
    // Encabezado: fija columnas.
    const iDesc = celdas.findIndex((c) => clave(c) === "DESCRIPCION");
    if (iDesc >= 0) {
      const iCant = celdas.findIndex((c) => clave(c) === "CANTIDAD");
      const iPrecio = celdas.findIndex((c) => clave(c) === "PRECIO");
      if (iCant >= 0) col = { desc: iDesc, cant: iCant, precio: iPrecio >= 0 ? iPrecio : null };
      continue;
    }
    if (!col || cerrada) {
      // Antes del primer encabezado puede venir la sección (QUIRÓFANO).
      if (!col) {
        const unica = celdas.filter((c) => texto(c));
        if (unica.length === 1 && !/[:]/.test(texto(unica[0])) && texto(unica[0]) === texto(unica[0]).toUpperCase()) seccion = texto(unica[0]);
      }
      continue;
    }
    const desc = texto(celdas[col.desc] ?? null);
    const cant = numero(celdas[col.cant] ?? null);
    const precio = col.precio != null ? numero(celdas[col.precio] ?? null) : null;
    if (!desc) {
      // Fila sin descripción con números: el gran total; lo que sigue ya no es tabla.
      if (celdas.some((c) => numero(c) != null) || celdas.some((c) => /TOTAL/.test(clave(c)))) cerrada = true;
      continue;
    }
    if (/^TOTAL\b/.test(clave(desc))) continue;
    if (cant == null && precio == null && celdas.every((c, i) => i === col!.desc || c == null || texto(c) === "")) {
      seccion = desc;
      continue;
    }
    if (cant == null || !(cant > 0)) {
      avisos.push(`«${desc}» sin cantidad: no se importó`);
      continue;
    }
    renglones.push({ descripcion: desc, cantidad: cant, precio: precio != null && precio > 0 ? r2(precio) : null, seccion, categoria: categoriaDeSeccion(seccion) });
  }

  // Estancia y quirófano, de los renglones que los dicen.
  const habitacion = renglones.find((r) => r.categoria === "HABITACION" && /HABITACION/.test(normalizar(r.descripcion)));
  const completa = habitacion && (/ESTANCIA COMPLETA/.test(normalizar(habitacion.descripcion)) || habitacion.cantidad > 1);
  const sala = renglones.find((r) => /QUIROFANO POR HORA/.test(normalizar(r.descripcion)));

  if (!nombre) nombre = enOracion(h.nombre);
  if (renglones.length === 0) avisos.push("La hoja no trae renglones con cantidad");
  return {
    hoja: h.nombre,
    clave: claveDeHoja(h.nombre),
    nombre,
    renglones,
    totalConIva,
    precioPaquete,
    tipoEpisodio: completa ? "HOSPITALIZACION" : "AMBULATORIO",
    estanciaNoches: completa ? Math.round(habitacion!.cantidad) : 0,
    quirofanoMinutos: sala ? Math.round(sala.cantidad * 60) : null,
    avisos,
  };
}

/** Dos hojas con el mismo título (ARTROSCOPIA y ARTROSCOPIA AMB): el nombre lleva la hoja. */
export function leerTablas(hojas: Hoja[]): TablaProtocolo[] {
  const tablas = hojas.map(leerHoja).filter((t) => t.renglones.length > 0);
  const veces = new Map<string, number>();
  for (const t of tablas) veces.set(t.nombre, (veces.get(t.nombre) ?? 0) + 1);
  return tablas.map((t) => ((veces.get(t.nombre) ?? 0) > 1 ? { ...t, nombre: `${t.nombre} · ${t.hoja.trim()}` } : t));
}

export interface PartidaPlaneada extends RenglonTabla {
  servicioId: string | null;
  servicio: { clave: string; nombre: string; precio: number } | null;
}

/** Empareja cada renglón con el tarifario (sólo si gana con claridad). */
export function emparejarTabla(t: TablaProtocolo, indice: Indice): PartidaPlaneada[] {
  const porId = new Map(indice.servicios.map((s) => [s.id, s]));
  return t.renglones.map((r) => {
    const { servicioId } = emparejar(r.descripcion, indice);
    const s = servicioId ? porId.get(servicioId) : null;
    return { ...r, servicioId: s?.id ?? null, servicio: s ? { clave: s.clave, nombre: s.nombre, precio: s.precio } : null };
  });
}
