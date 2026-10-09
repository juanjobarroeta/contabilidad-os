// ─────────────────────────────────────────────────────────────────────────────
// Importar la lista de precios del hospital al tarifario.
//
// El hospital exporta de su sistema anterior una hoja con Clave, Descripción,
// Grupo (LC, PAT, ENDOS, TAC…), Lista de precio (PARTICULAR, una aseguradora)
// y Precio. Las claves y los conceptos casi no cambian; los precios sí, así
// que la misma hoja se vuelve a subir cada vez que cambian: se cruza por
// clave, lo nuevo se crea, lo que cambió se actualiza y lo demás no se toca.
//
// Destino: el precio de lista (particular) o el tabulador de un pagador
// (HospTarifa). Todo es puro salvo `filasDeArchivo` (xlsx).
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import type { HospCargoCategoria } from "@prisma/client";
import { HospitalError } from "./errores";
import { r2 } from "./util";

export interface FilaLista {
  fila: number;
  clave: string;
  descripcion: string;
  grupo: string | null;
  lista: string | null;
  precio: number;
}

export interface LecturaLista {
  filas: FilaLista[];
  errores: Array<{ fila: number; motivo: string }>;
  /** Listas de precio distintas que trae la hoja (columna «lista de precio»). */
  listas: string[];
}

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const COLUMNAS: Record<"clave" | "descripcion" | "grupo" | "lista" | "precio", string[]> = {
  clave: ["clave", "codigo", "cve", "sku", "clave interna"],
  descripcion: ["descripcion", "nombre", "concepto", "servicio", "articulo"],
  grupo: ["grupo", "departamento", "familia", "area", "categoria"],
  lista: ["lista de precio", "lista de precios", "lista", "tabulador"],
  precio: ["precio", "precio unitario", "importe", "tarifa", "precio lista"],
};

function numero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Lee filas crudas (primera hoja) de un xlsx/xls/csv. */
export function filasDeArchivo(buffer: Buffer): unknown[][] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  } catch {
    throw new HospitalError(400, "No se pudo leer el archivo: súbelo como .xlsx, .xls o .csv");
  }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  if (!hoja) throw new HospitalError(400, "El archivo no trae hojas");
  return XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, defval: null, raw: true });
}

/** Encuentra el encabezado y lee las filas. Una fila sin clave o sin precio válido va a `errores`. */
export function leerListaPrecios(crudas: unknown[][]): LecturaLista {
  const iEnc = crudas.slice(0, 15).findIndex((r) => Array.isArray(r) && r.some((c) => COLUMNAS.clave.includes(norm(c))));
  if (iEnc < 0) throw new HospitalError(400, "No encontré el encabezado: la hoja necesita columnas «Clave», «Descripción» y «Precio»");
  const enc = (crudas[iEnc] as unknown[]).map(norm);
  const col = (k: keyof typeof COLUMNAS) => {
    for (const nombre of COLUMNAS[k]) {
      const i = enc.indexOf(nombre);
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = { clave: col("clave"), descripcion: col("descripcion"), grupo: col("grupo"), lista: col("lista"), precio: col("precio") };
  if (c.descripcion < 0 || c.precio < 0) throw new HospitalError(400, "Faltan columnas: la hoja necesita «Clave», «Descripción» y «Precio»");

  const filas: FilaLista[] = [];
  const errores: LecturaLista["errores"] = [];
  const vistas = new Map<string, number>();
  crudas.slice(iEnc + 1).forEach((r, i) => {
    const fila = iEnc + 2 + i;
    if (!Array.isArray(r) || r.every((v) => v == null || String(v).trim() === "")) return;
    const clave = String(r[c.clave] ?? "").replace(/\s+/g, "").toUpperCase();
    const descripcion = String(r[c.descripcion] ?? "").replace(/\s+/g, " ").trim();
    const precio = numero(r[c.precio]);
    if (!clave) return void errores.push({ fila, motivo: "sin clave" });
    if (clave.length > 40) return void errores.push({ fila, motivo: `clave ${clave.slice(0, 20)}… de más de 40 caracteres` });
    if (!descripcion) return void errores.push({ fila, motivo: `${clave}: sin descripción` });
    if (precio == null || precio < 0) return void errores.push({ fila, motivo: `${clave}: precio inválido` });
    const lista = c.lista >= 0 ? String(r[c.lista] ?? "").trim() || null : null;
    const llave = `${clave}|${norm(lista)}`;
    if (vistas.has(llave)) return void errores.push({ fila, motivo: `${clave}: repetida (ya viene en la fila ${vistas.get(llave)})` });
    vistas.set(llave, fila);
    filas.push({
      fila,
      clave,
      descripcion: descripcion.slice(0, 200),
      grupo: c.grupo >= 0 ? String(r[c.grupo] ?? "").trim().toUpperCase() || null : null,
      lista,
      precio: r2(precio),
    });
  });
  const listas = [...new Set(filas.map((f) => f.lista).filter((x): x is string => !!x))];
  return { filas, errores, listas };
}

/**
 * Categoría del cargo para un grupo de la lista del hospital. Lo que no se
 * reconoce queda en OTRO: la categoría se puede corregir después en el
 * tarifario y una reimportación no la pisa.
 */
const CATEGORIA_POR_GRUPO: Array<[RegExp, HospCargoCategoria]> = [
  [/^(LC|LAB|PAT|BM|IHQ|CIT|RYX|RX|TAC|ULT|US|RM|CARD|BS|IMG)/, "ESTUDIO"],
  [/^(ENDOS|QUI|QX|RECP|CEYE|IPE)/, "QUIROFANO"],
  [/^URG/, "URGENCIAS"],
  [/^HON/, "HONORARIO"],
  [/^(HAB|CUARTO|ESTANCIA)/, "HABITACION"],
  [/^(FAR|MED)/, "FARMACIA"],
  [/^(MAT|INS)/, "MATERIAL"],
  [/^(HOSP|UCI|INH|ONC|PAQ|NUT|CM)/, "PROCEDIMIENTO"],
];
export function categoriaDeGrupo(grupo: string | null): HospCargoCategoria {
  const g = (grupo ?? "").toUpperCase().replace(/\s+/g, "");
  return CATEGORIA_POR_GRUPO.find(([re]) => re.test(g))?.[1] ?? "OTRO";
}

export interface ServicioExistente {
  id: string;
  clave: string;
  nombre: string;
  grupo: string | null;
  precioLista: number;
  activo: boolean;
  /** Precio en el tabulador del pagador destino, si hay. */
  precioPagador?: number | null;
}

export interface PlanImportacion {
  nuevos: FilaLista[];
  /** Ya existen y cambia el precio, el nombre o el grupo (o estaban dados de baja). */
  cambios: Array<FilaLista & { id: string; antes: number | null; cambiaNombre: boolean; reactivar: boolean }>;
  iguales: number;
  /** Del tarifario y no vienen en la hoja (sólo aplica al precio de lista). */
  faltantes: Array<{ id: string; clave: string; nombre: string }>;
}

/** Qué haría la importación. `destino = "LISTA"` o el id de un pagador. */
export function planearImportacion(filas: FilaLista[], existentes: ServicioExistente[], destino: "LISTA" | { pagadorId: string }): PlanImportacion {
  const porClave = new Map(existentes.map((s) => [s.clave.toUpperCase(), s]));
  const plan: PlanImportacion = { nuevos: [], cambios: [], iguales: 0, faltantes: [] };
  const enHoja = new Set<string>();
  for (const f of filas) {
    enHoja.add(f.clave);
    const s = porClave.get(f.clave);
    if (!s) { plan.nuevos.push(f); continue; }
    const antes = destino === "LISTA" ? s.precioLista : s.precioPagador ?? null;
    const cambiaPrecio = antes == null || Math.abs(antes - f.precio) >= 0.005;
    const cambiaNombre = s.nombre.trim() !== f.descripcion;
    const cambiaGrupo = destino === "LISTA" && f.grupo != null && (s.grupo ?? null) !== f.grupo;
    const reactivar = destino === "LISTA" && !s.activo;
    if (cambiaPrecio || (destino === "LISTA" && cambiaNombre) || cambiaGrupo || reactivar) {
      plan.cambios.push({ ...f, id: s.id, antes, cambiaNombre: destino === "LISTA" && cambiaNombre, reactivar });
    } else plan.iguales++;
  }
  if (destino === "LISTA") {
    plan.faltantes = existentes.filter((s) => s.activo && !enHoja.has(s.clave.toUpperCase())).map(({ id, clave, nombre }) => ({ id, clave, nombre }));
  }
  return plan;
}

/** Resumen para la pantalla: cuántos y una muestra de cambios de precio. */
export function resumirPlan(plan: PlanImportacion, muestra = 50) {
  const subidas = plan.cambios.filter((c) => c.antes != null && c.precio > c.antes).length;
  return {
    nuevos: plan.nuevos.length,
    cambios: plan.cambios.length,
    iguales: plan.iguales,
    faltantes: plan.faltantes.length,
    subidas,
    muestraNuevos: plan.nuevos.slice(0, muestra).map((f) => ({ clave: f.clave, nombre: f.descripcion, grupo: f.grupo, precio: f.precio })),
    muestraCambios: plan.cambios.slice(0, muestra).map((c) => ({ clave: c.clave, nombre: c.descripcion, antes: c.antes, despues: c.precio, cambiaNombre: c.cambiaNombre, reactivar: c.reactivar })),
    muestraFaltantes: plan.faltantes.slice(0, muestra),
  };
}
