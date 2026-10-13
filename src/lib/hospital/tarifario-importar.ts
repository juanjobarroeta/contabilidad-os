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
  /** Listas de precio distintas que trae la hoja (columna «lista de precio», o los encabezados en formato ancho). */
  listas: string[];
  /**
   * LARGO: una fila por clave y lista (Clave, Descripción, Grupo, Lista, Precio).
   * ANCHO: una fila por clave y una COLUMNA de precio por lista (Clave,
   * Descripción, BUPA, PARTICULAR, SURA…). En ancho cada celda con precio se
   * vuelve una FilaLista con `lista` = el encabezado de su columna.
   */
  formato: "LARGO" | "ANCHO";
  /** Sólo en ANCHO: cada columna de precio y cuántas filas traen precio en ella. */
  columnasPrecio: Array<{ encabezado: string; filasConPrecio: number }>;
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
  if (c.descripcion >= 0 && c.precio < 0 && c.lista < 0) {
    const ancho = leerFormatoAncho(crudas, iEnc, c);
    if (ancho) return ancho;
  }
  if (c.descripcion < 0 || c.precio < 0) throw new HospitalError(400, "Faltan columnas: la hoja necesita «Clave», «Descripción» y «Precio» (o una columna de precio por lista)");

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
  return { filas, errores, listas, formato: "LARGO", columnasPrecio: [] };
}

/** El grupo cuando la hoja no trae columna: las letras con que empieza la clave (LC001 → LC, ENDOS011 → ENDOS). */
export function grupoDeClave(clave: string): string | null {
  return /^[A-Z]+/.exec(clave)?.[0] ?? null;
}

/**
 * Formato ANCHO: tras Clave y Descripción, cada columna cuyo contenido es
 * casi todo precio es una lista (BUPA, PARTICULAR, SURA…). Una celda vacía es
 * «esa lista no cobra esto», no un error. Devuelve null si no hay ninguna
 * columna con cara de precios.
 */
function leerFormatoAncho(
  crudas: unknown[][],
  iEnc: number,
  c: { clave: number; descripcion: number; grupo: number },
): LecturaLista | null {
  const encCrudo = crudas[iEnc] as unknown[];
  const cuerpo = crudas.slice(iEnc + 1).filter((r) => Array.isArray(r) && r.some((v) => v != null && String(v).trim() !== ""));
  const vacia = (v: unknown) => v == null || String(v).trim() === "";
  const columnas: Array<{ i: number; encabezado: string }> = [];
  encCrudo.forEach((h, i) => {
    const encabezado = String(h ?? "").replace(/\s+/g, " ").trim();
    if (!encabezado || i === c.clave || i === c.descripcion || i === c.grupo) return;
    const llenas = cuerpo.map((r) => (r as unknown[])[i]).filter((v) => !vacia(v));
    if (llenas.length === 0) return;
    const numericas = llenas.filter((v) => numero(v) != null).length;
    if (numericas / llenas.length >= 0.8) columnas.push({ i, encabezado });
  });
  if (columnas.length === 0) return null;

  const filas: FilaLista[] = [];
  const errores: LecturaLista["errores"] = [];
  const vistas = new Map<string, number>();
  const conPrecio = new Map<string, number>();
  crudas.slice(iEnc + 1).forEach((r, k) => {
    const fila = iEnc + 2 + k;
    if (!Array.isArray(r) || r.every((v) => vacia(v))) return;
    const clave = String(r[c.clave] ?? "").replace(/\s+/g, "").toUpperCase();
    const descripcion = String(r[c.descripcion] ?? "").replace(/\s+/g, " ").trim();
    if (!clave) return void errores.push({ fila, motivo: "sin clave" });
    if (clave.length > 40) return void errores.push({ fila, motivo: `clave ${clave.slice(0, 20)}… de más de 40 caracteres` });
    if (!descripcion) return void errores.push({ fila, motivo: `${clave}: sin descripción` });
    if (vistas.has(clave)) return void errores.push({ fila, motivo: `${clave}: repetida (ya viene en la fila ${vistas.get(clave)})` });
    vistas.set(clave, fila);
    const grupo = c.grupo >= 0 ? String(r[c.grupo] ?? "").trim().toUpperCase() || null : grupoDeClave(clave);
    let alguna = false;
    for (const { i, encabezado } of columnas) {
      if (vacia(r[i])) continue;
      const precio = numero(r[i]);
      if (precio == null || precio < 0) { errores.push({ fila, motivo: `${clave}: precio inválido en ${encabezado}` }); continue; }
      alguna = true;
      conPrecio.set(encabezado, (conPrecio.get(encabezado) ?? 0) + 1);
      filas.push({ fila, clave, descripcion: descripcion.slice(0, 200), grupo, lista: encabezado, precio: r2(precio) });
    }
    if (!alguna) errores.push({ fila, motivo: `${clave}: sin precio en ninguna lista` });
  });
  return {
    filas,
    errores,
    listas: columnas.map((x) => x.encabezado),
    formato: "ANCHO",
    columnasPrecio: columnas.map((x) => ({ encabezado: x.encabezado, filasConPrecio: conPrecio.get(x.encabezado) ?? 0 })),
  };
}

// ── Mapeo columna → destino ──────────────────────────────────────────────────

export type DestinoColumna =
  | { tipo: "LISTA" }
  | { tipo: "PAGADOR"; pagadorId: string }
  | { tipo: "NUEVO"; nombre: string; pagadorTipo: "ASEGURADORA" | "EMPRESA" | "GOBIERNO" | "PARTICULAR" }
  | { tipo: "OMITIR" };

/**
 * Lee un destino del mapeo: "LISTA" | <pagadorId> | "NUEVO:<nombre>" |
 * "NUEVO:<TIPO>:<nombre>" | "OMITIR" (o vacío).
 */
export function destinoDeMapeo(valor: unknown): DestinoColumna {
  const v = String(valor ?? "").trim();
  if (!v || v === "OMITIR") return { tipo: "OMITIR" };
  if (v === "LISTA") return { tipo: "LISTA" };
  if (v.startsWith("NUEVO:")) {
    const resto = v.slice(6);
    const m = /^(ASEGURADORA|EMPRESA|GOBIERNO|PARTICULAR):(.*)$/.exec(resto);
    const nombre = (m ? m[2] : resto).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!nombre) return { tipo: "OMITIR" };
    return { tipo: "NUEVO", nombre, pagadorTipo: (m?.[1] as "ASEGURADORA" | "EMPRESA" | "GOBIERNO" | "PARTICULAR") ?? "ASEGURADORA" };
  }
  return { tipo: "PAGADOR", pagadorId: v };
}

const RUIDO = new Set(["sa", "de", "cv", "sab", "sapi", "s", "a", "c", "v", "rl", "srl", "compania", "cia", "seguros", "seguro", "grupo", "y", "la", "el", "del", "mexico", "servicios"]);
const compacto = (s: string) =>
  norm(s)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((t) => t && !RUIDO.has(t))
    .join("");
const tokens = (s: string) => norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((t) => t && !RUIDO.has(t));

/** La llave de un encabezado en la tabla de alias: sin acentos, espacios ni signos. */
export function llaveEncabezado(encabezado: string): string {
  return norm(encabezado).replace(/[^a-z0-9]/g, "");
}

export type TipoPagadorLista = "ASEGURADORA" | "EMPRESA" | "GOBIERNO" | "PARTICULAR";

/**
 * Lo que se sabe de una columna: el pagador al que fue la última vez, o con
 * qué nombre y tipo crearlo. `confirmado: false` = es una suposición y la
 * pantalla pide revisarla.
 */
export type AliasColumna = { pagadorId: string } | { nombre: string; tipo: TipoPagadorLista; confirmado?: boolean };

/**
 * Lo que dijo el dueño de la lista de CENTRO (oct-2026) y vale para cualquier
 * hospital con los mismos encabezados. Lo de cada empresa vive en
 * HospConfig.aliasTarifas y manda sobre esto.
 */
export const ALIAS_BASE: Record<string, AliasColumna> = {
  partext: { nombre: "Particular externo", tipo: "PARTICULAR", confirmado: true },
  pxexterno: { nombre: "Paciente externo", tipo: "PARTICULAR", confirmado: true },
  sofia: { nombre: "Sofía", tipo: "EMPRESA", confirmado: true },
  bupa: { nombre: "BUPA", tipo: "ASEGURADORA", confirmado: false },
  mediproses: { nombre: "MEDIPROSES", tipo: "EMPRESA", confirmado: false },
  vita: { nombre: "VITA", tipo: "EMPRESA", confirmado: false },
};

export interface SugerenciaMapeo {
  /** encabezado → "LISTA" | pagadorId | "NUEVO:<TIPO>:<nombre>" | null. */
  mapeo: Record<string, string | null>;
  /** Encabezados cuya sugerencia es una suposición: la pantalla pide confirmarla. */
  porConfirmar: string[];
}

/**
 * Sugiere a qué va cada columna, en este orden:
 *  1. PARTICULAR → precio de lista.
 *  2. Lo que la empresa ya decidió antes (alias con pagadorId).
 *  3. Un pagador cuyo tabulador o nombre coincide: exacto (sin acentos ni
 *     «Seguros», «SA de CV»…), uno empieza con el otro (PLANSEG ↔ Plan
 *     Seguro) o la primera palabra completa del pagador (ONCOCENTER ↔ Onco
 *     Hope). Si dos empatan no se adivina.
 *  4. Un alias con nombre: el pagador con ese nombre si ya existe; si no,
 *     crearlo (NUEVO).
 *  5. Nada de lo anterior: crear uno con el nombre de la columna, tipo
 *     EMPRESA, marcado por confirmar.
 */
export function sugerirMapeo(
  encabezados: string[],
  pagadores: Array<{ id: string; nombre: string; tabulador: string | null; activo?: boolean }>,
  aliasEmpresa: Record<string, AliasColumna> = {},
): SugerenciaMapeo {
  const mapeo: Record<string, string | null> = {};
  const porConfirmar: string[] = [];
  const usados = new Set<string>();
  const vivos = pagadores.filter((p) => p.activo !== false);
  for (const enc of encabezados) {
    const ce = compacto(enc);
    const llave = llaveEncabezado(enc);
    if (ce === "particular") { mapeo[enc] = "LISTA"; continue; }

    const alias = aliasEmpresa[llave] ?? ALIAS_BASE[llave];
    if (alias && "pagadorId" in alias && vivos.some((p) => p.id === alias.pagadorId) && !usados.has(alias.pagadorId)) {
      mapeo[enc] = alias.pagadorId; usados.add(alias.pagadorId); continue;
    }

    let mejor: { id: string; puntos: number } | null = null;
    let empate = false;
    for (const p of vivos) {
      if (usados.has(p.id)) continue;
      let puntos = 0;
      for (const n of [p.tabulador, p.nombre].filter((x): x is string => !!x)) {
        const cn = compacto(n);
        if (!cn || !ce) continue;
        if (cn === ce) puntos = Math.max(puntos, 3);
        else if (Math.min(cn.length, ce.length) >= 4 && (cn.startsWith(ce) || ce.startsWith(cn))) puntos = Math.max(puntos, 2);
        else {
          const primera = tokens(n)[0];
          if (primera && primera.length >= 4 && ce.startsWith(primera)) puntos = Math.max(puntos, 1);
        }
      }
      if (!puntos) continue;
      if (!mejor || puntos > mejor.puntos) { mejor = { id: p.id, puntos }; empate = false; }
      else if (puntos === mejor.puntos) empate = true;
    }
    if (mejor && !empate) { mapeo[enc] = mejor.id; usados.add(mejor.id); continue; }

    if (alias && "nombre" in alias) {
      const ya = vivos.find((p) => !usados.has(p.id) && compacto(p.nombre) === compacto(alias.nombre));
      if (ya) { mapeo[enc] = ya.id; usados.add(ya.id); }
      else mapeo[enc] = `NUEVO:${alias.tipo}:${alias.nombre}`;
      if (alias.confirmado === false) porConfirmar.push(enc);
      continue;
    }

    mapeo[enc] = `NUEVO:EMPRESA:${enc}`;
    porConfirmar.push(enc);
  }
  return { mapeo, porConfirmar };
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
