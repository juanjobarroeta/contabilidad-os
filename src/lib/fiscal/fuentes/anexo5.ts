// ─────────────────────────────────────────────────────────────────────────────
// Anexo 5 de la RMF — «Cantidades actualizadas del CFF» (multas, umbrales,
// gastos de ejecución). Lo publica el SAT en su minisitio como PDF del DOF.
//
// El parser es PURO: recibe el texto del PDF (textoDePdf) y devuelve filas
// tipadas con artículo / fracción / inciso y los montos. Se prueba con el
// fixture real de 2026. La descarga vive en sat-anexos.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { fechaIso, limpiarLineasDof, montoNumero } from "./texto";

export type SeccionAnexo5 = "A" | "B" | "C";

export interface MultaFila {
  /** A = cantidades actualizadas; B = compilación (no actualizadas este año); C = regla 9.1.5. */
  seccion: SeccionAnexo5;
  /** «82», «84-B», «32-A». */
  articulo: string;
  /** Fracción en romano («I», «XXVI») o null. */
  fraccion: string | null;
  /** Inciso («a») o null. */
  inciso: string | null;
  /** Monto mínimo, o el único monto cuando `maximo` es null. */
  minimo: number;
  /** Monto máximo; null cuando la fila es un monto único (umbral, gasto de ejecución, multa fija). */
  maximo: number | null;
  /** Porcentaje cuando la multa se expresa «entre el N % de … y $X». */
  porcentaje?: number;
  /** Texto del párrafo (recortado) para que el copiloto lo cite. */
  texto: string;
}

export interface Anexo5Parseado {
  ejercicio: number;
  /** Fecha del DOF («2025-12-28») si se pudo leer. */
  dof: string | null;
  /** Vigencia declarada («entrarán en vigor a partir del 1 de enero de 2026»). */
  vigenciaDesde: string | null;
  filas: MultaFila[];
}

// Con mayúscula y punto tras el número: «artículo 23 de este Código.» (una
// referencia dentro de un párrafo) NO es encabezado.
const RE_ARTICULO = /^Artículo\s+(\d+(?:-[A-Z]+)?(?:\s+Bis)?)(?:\.\s*(.*)|\s*)$/;
const RE_FRACCION = /^([IVXLC]+)\.\s*(.*)$/;
const RE_INCISO = /^([a-z])\)\s*(.*)$/;
const RE_SECCION = /^([ABC])\.\s+(Cantidades actualizadas|Compilaci[óo]n|Regla)/i;
const RE_RANGO = /(?:de|entre)\s+\$\s?([\d,]+(?:\.\d{2})?)\s+(?:a|y)\s+\$\s?([\d,]+(?:\.\d{2})?)/gi;
const RE_MENOR_MAYOR = /menor\s+de\s+\$\s?([\d,]+(?:\.\d{2})?)\s+ni\s+mayor\s+de\s+\$\s?([\d,]+(?:\.\d{2})?)/i;
const RE_PORCENTAJE = /entre\s+el\s+(\d+(?:\.\d+)?)\s?%/i;
const RE_MONTO = /\$\s?([\d,]+(?:\.\d{2})?)/g;
const TEXTO_MAX = 320;

interface Parrafo {
  seccion: SeccionAnexo5;
  articulo: string;
  fraccion: string | null;
  inciso: string | null;
  texto: string;
}

/** Agrupa las líneas limpias en párrafos con su contexto (artículo/fracción/inciso). Puro. */
function parrafos(lineas: string[]): Parrafo[] {
  const out: Parrafo[] = [];
  let seccion: SeccionAnexo5 = "A";
  let articulo: string | null = null;
  let fraccion: string | null = null;
  let inciso: string | null = null;
  let actual: Parrafo | null = null;
  const abrir = (texto: string | undefined): Parrafo | null => {
    if (!articulo) return null;
    const p: Parrafo = { seccion, articulo, fraccion, inciso, texto: texto ?? "" };
    out.push(p);
    return p;
  };
  for (const line of lineas) {
    const s = RE_SECCION.exec(line);
    if (s) {
      seccion = s[1].toUpperCase() as SeccionAnexo5;
      actual = null;
      continue;
    }
    const a = RE_ARTICULO.exec(line);
    if (a) {
      articulo = a[1].replace(/\s+bis$/i, " Bis");
      fraccion = null;
      inciso = null;
      actual = abrir(a[2]);
      continue;
    }
    const f = RE_FRACCION.exec(line);
    if (f && articulo) {
      fraccion = f[1];
      inciso = null;
      actual = abrir(f[2]);
      continue;
    }
    const i = RE_INCISO.exec(line);
    if (i && articulo) {
      inciso = i[1];
      actual = abrir(i[2]);
      continue;
    }
    if (actual) actual.texto = `${actual.texto} ${line}`.trim();
  }
  return out;
}

/** Filas de montos de un párrafo. Puro. */
function filasDeParrafo(p: Parrafo): MultaFila[] {
  const texto = p.texto.replace(/\s+/g, " ").trim();
  if (!texto.includes("$")) return [];
  const base = { seccion: p.seccion, articulo: p.articulo, fraccion: p.fraccion, inciso: p.inciso, texto: texto.slice(0, TEXTO_MAX) };
  const out: MultaFila[] = [];

  const pct = RE_PORCENTAJE.exec(texto);
  const mm = RE_MENOR_MAYOR.exec(texto);
  if (pct && mm) {
    out.push({ ...base, minimo: montoNumero(mm[1]), maximo: montoNumero(mm[2]), porcentaje: Number(pct[1]) });
    return out;
  }
  for (const m of texto.matchAll(RE_RANGO)) {
    out.push({ ...base, minimo: montoNumero(m[1]), maximo: montoNumero(m[2]) });
  }
  if (out.length > 0) return out;
  if (pct) {
    const montos = [...texto.matchAll(RE_MONTO)].map((m) => montoNumero(m[1]));
    if (montos.length) out.push({ ...base, minimo: montos[0], maximo: null, porcentaje: Number(pct[1]) });
    return out;
  }
  for (const m of texto.matchAll(RE_MONTO)) {
    out.push({ ...base, minimo: montoNumero(m[1]), maximo: null });
  }
  return out;
}

/** Parsea el texto completo del Anexo 5. Puro. */
export function parseAnexo5(texto: string): Anexo5Parseado {
  const ej = /RESOLUCI[ÓO]N MISCEL[ÁA]NEA FISCAL PARA\s+(\d{4})/i.exec(texto);
  const dofM = /DIARIO OFICIAL\s+\w+\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto);
  const vigM = /entrar[áa]n?\s+en\s+vigor\s+a\s+partir\s+del\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto);
  const lineas = limpiarLineasDof(texto);
  const filas = parrafos(lineas).flatMap(filasDeParrafo);
  return {
    ejercicio: ej ? Number(ej[1]) : NaN,
    dof: dofM ? fechaIso(dofM[1], dofM[2], dofM[3]) : null,
    vigenciaDesde: vigM ? fechaIso(vigM[1], vigM[2], vigM[3]) : null,
    filas,
  };
}
