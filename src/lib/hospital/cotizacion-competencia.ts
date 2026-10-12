// ─────────────────────────────────────────────────────────────────────────────
// Cotización de OTRO hospital: lo que la IA leyó del PDF/foto se limpia aquí y
// cada renglón se empareja con el tarifario propio para repreciarlo.
//
// El emparejamiento es determinista (palabras en común, sin acentos ni marcas
// de puntuación; los números cuentan: «JERINGA 3 ML» no es «JERINGA 20 ML»):
// el tarifario puede tener miles de servicios y mandarlos al modelo saldría
// caro y lento. Sólo se propone UNO como firme cuando gana con claridad; si no,
// van los candidatos y la persona elige.
// ─────────────────────────────────────────────────────────────────────────────

import { r2 } from "./util";

export const GRUPOS_COMPETENCIA = ["HOSPITALIZACION", "QUIROFANO", "INSUMOS", "MEDICAMENTOS", "SOLUCIONES", "SERVICIOS", "ESTUDIOS", "HONORARIOS", "OTRO"] as const;
export type GrupoCompetencia = (typeof GRUPOS_COMPETENCIA)[number];

export interface RenglonLeido {
  cantidad: number;
  descripcion: string;
  grupo: GrupoCompetencia;
  /** Precio unitario del competidor si lo trae (con o sin IVA según `preciosIncluyenIva`). */
  precioUnitario: number | null;
  importe: number | null;
}

export interface CotizacionLeida {
  hospital: string | null;
  procedimiento: string | null;
  total: number | null;
  totalIncluyeIva: boolean | null;
  vigencia: string | null;
  notas: string | null;
  renglones: RenglonLeido[];
}

const texto = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** «25,700.00», «$1234.5» o 1234.5 → número > 0; basura → null. */
export function importeLeido(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? r2(v) : null;
  const s = texto(v, 30);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? r2(n) : null;
}

const grupoDe = (v: unknown): GrupoCompetencia => {
  const g = normalizar(texto(v, 40) ?? "").replace(/ /g, "");
  return (GRUPOS_COMPETENCIA as readonly string[]).includes(g) ? (g as GrupoCompetencia) : "OTRO";
};

/** Limpia la salida del modelo: tipos, topes, renglones sin descripción fuera. */
export function limpiarLectura(x: unknown): CotizacionLeida {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const crudos = Array.isArray(o.renglones) ? o.renglones.slice(0, 400) : [];
  const renglones: RenglonLeido[] = [];
  for (const r of crudos) {
    if (!r || typeof r !== "object") continue;
    const c = r as Record<string, unknown>;
    const descripcion = texto(c.descripcion);
    if (!descripcion) continue;
    const cantidad = typeof c.cantidad === "number" && Number.isFinite(c.cantidad) && c.cantidad > 0 ? Math.min(c.cantidad, 100000) : importeLeido(c.cantidad) ?? 1;
    renglones.push({ cantidad, descripcion, grupo: grupoDe(c.grupo), precioUnitario: importeLeido(c.precioUnitario), importe: importeLeido(c.importe) });
  }
  return {
    hospital: texto(o.hospital, 200),
    procedimiento: texto(o.procedimiento),
    total: importeLeido(o.total),
    totalIncluyeIva: typeof o.totalIncluyeIva === "boolean" ? o.totalIncluyeIva : null,
    vigencia: texto(o.vigencia, 60),
    notas: texto(o.notas, 600),
    renglones,
  };
}

// ── Emparejamiento ───────────────────────────────────────────────────────────

/** MAYÚSCULAS sin acentos; la Ñ se conserva; los números y decimales también. */
export function normalizar(s: string): string {
  return s
    .toUpperCase()
    .replace(/Ñ/g, "\u0001")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\u0001/g, "Ñ")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^A-ZÑ0-9.\s]/g, " ")
    // «20ML», «8.0MM», «10X10» → número y unidad aparte.
    .replace(/(\d)(?=[A-ZÑ])/g, "$1 ")
    .replace(/([A-ZÑ])(?=\d)/g, "$1 ")
    .replace(/\.(?!\d)|(?<!\d)\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VACIAS = new Set(["DE", "DEL", "LA", "EL", "LOS", "LAS", "CON", "SIN", "Y", "PARA", "POR", "EN", "A", "AL", "X", "C", "S", "NO", "REF", "TIPO", "PZA", "PIEZA", "PIEZAS"]);

/** Plural simple: JERINGAS → JERINGA, SOLUCIONES → SOLUCION. */
const raiz = (t: string) => (/^\d/.test(t) || t.length <= 4 ? t : t.endsWith("ES") && t.length > 6 ? t.slice(0, -2) : t.endsWith("S") ? t.slice(0, -1) : t);

export function fichas(s: string): string[] {
  return [...new Set(normalizar(s).split(" ").filter((t) => t && !VACIAS.has(t)).map(raiz))];
}

const esNumero = (t: string) => /^\d/.test(t);

/**
 * 0..1: proporción de palabras en común (Dice). Si los dos traen números y no
 * comparten ninguno, es otra presentación: se castiga a la mitad.
 */
export function parecido(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const comunes = a.filter((t) => sb.has(t));
  let s = (2 * comunes.length) / (a.length + b.length);
  const na = a.filter(esNumero), nb = b.filter(esNumero);
  if (na.length && nb.length && !comunes.some(esNumero)) s *= 0.5;
  // Una sola palabra en común que es un número no dice nada.
  if (comunes.length > 0 && comunes.every(esNumero)) s = 0;
  return s;
}

export interface ServicioTarifa {
  id: string;
  clave: string;
  nombre: string;
  categoria: string;
  precio: number;
  /** null = exento. */
  ivaTasa: number | null;
}

export interface Candidato extends ServicioTarifa {
  parecido: number;
}

/** Umbral para proponer y margen sobre el segundo para darlo por firme. */
const MINIMO = 0.45;
const FIRME = 0.6;
const MARGEN = 0.1;

export interface Indice {
  servicios: ServicioTarifa[];
  fichas: string[][];
  porFicha: Map<string, number[]>;
}

export function indexar(servicios: ServicioTarifa[]): Indice {
  const f = servicios.map((s) => fichas(s.nombre));
  const porFicha = new Map<string, number[]>();
  f.forEach((ts, i) => {
    for (const t of ts) {
      if (esNumero(t)) continue;
      const l = porFicha.get(t);
      if (l) l.push(i);
      else porFicha.set(t, [i]);
    }
  });
  return { servicios, fichas: f, porFicha };
}

export function emparejar(descripcion: string, indice: Indice, max = 3): { candidatos: Candidato[]; servicioId: string | null } {
  const a = fichas(descripcion);
  const vistos = new Set<number>();
  for (const t of a) for (const i of indice.porFicha.get(t) ?? []) vistos.add(i);
  const candidatos = [...vistos]
    .map((i) => ({ ...indice.servicios[i], parecido: Math.round(parecido(a, indice.fichas[i]) * 100) / 100 }))
    .filter((c) => c.parecido >= MINIMO)
    .sort((x, y) => y.parecido - x.parecido || x.nombre.length - y.nombre.length)
    .slice(0, max);
  const [p, s] = candidatos;
  const firme = p && p.parecido >= FIRME && (!s || p.parecido - s.parecido >= MARGEN);
  return { candidatos, servicioId: firme ? p.id : null };
}

/** Total CON IVA de los renglones que sí tienen servicio elegido. */
export function totalPropio(renglones: Array<{ cantidad: number; servicio: ServicioTarifa | null }>): { total: number; conPrecio: number; sinPrecio: number } {
  let total = 0, conPrecio = 0, sinPrecio = 0;
  for (const r of renglones) {
    if (!r.servicio) { sinPrecio++; continue; }
    conPrecio++;
    const importe = r2(r.cantidad * r.servicio.precio);
    total += importe + (r.servicio.ivaTasa == null ? 0 : r2(importe * r.servicio.ivaTasa));
  }
  return { total: r2(total), conPrecio, sinPrecio };
}
