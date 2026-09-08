// ─────────────────────────────────────────────────────────────────────────────
// Comparación de nombres bancarios — módulo PURO, sin una sola import.
//
// Vive aparte de auto-conciliar.ts a propósito: auto-conciliar importa prisma,
// y estos helpers los necesita inferir-movimiento, que llega al bundle del
// NAVEGADOR vía la mesa (ConciliacionWorkbench importa CATEGORIAS_MESA). Un
// import de valor hacia auto-conciliar metió PrismaClient al cliente y tiró
// la pantalla de Bancos entera ("PrismaClient is unable to run in this
// browser environment"). Nada de este archivo puede importar nada con I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza para comparar nombres: sin acentos, sin puntuación, sin sufijos. */
export function normalizarNombre(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(S\.?A\.?|S\.?\s*DE\s*R\.?L\.?|DE\s*C\.?V\.?|S\.?C\.?|A\.?C\.?|SAPI)\b/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El nombre de la contraparte y el de la factura son la misma persona?
 *
 * Se exige que uno contenga al otro DESPUÉS de normalizar, y que el más corto
 * tenga al menos 6 caracteres. Sin ese piso, "SA" o "GRUPO" empatarían con
 * media cartera — y un match de nombre mal dado concilia la factura equivocada,
 * que es más caro que no conciliar.
 */
export function mismoNombre(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizarNombre(a ?? "");
  const y = normalizarNombre(b ?? "");
  if (x.length < 6 || y.length < 6) return false;
  if (x.includes(y) || y.includes(x)) return true;

  // Comparación por PALABRAS. La contención literal se rompe con dos cosas que
  // pasan todo el tiempo y no son errores de nadie:
  //   · el banco TRUNCA a un ancho fijo — «Esther Mendez Pere» por PEREZ;
  //   · el nombre está escrito distinto en el CFDI que en el banco —
  //     «MENESES» contra «MENESSES», una letra de diferencia.
  // Caso real: 16 empleados con el MISMO neto el mismo día; sin empatar el
  // nombre, los 16 puntúan igual y la conciliación no puede elegir — el pago
  // se queda sin conciliar aunque su recibo esté enfrente.
  //
  // Se exige que TODAS las palabras del nombre más corto tengan pareja en el
  // más largo (no una mayoría): «ROSA GARCIA VEGA» y «ROSA GARCIA LOPEZ» son
  // dos personas distintas, y con mayoría se casarían.
  const px = palabras(x);
  const py = palabras(y);
  if (px.length < 2 || py.length < 2) return false;
  const [corto, largo] = px.length <= py.length ? [px, py] : [py, px];
  return corto.every((t) => largo.some((u) => palabraCompatible(t, u)));
}

const palabras = (s: string): string[] => s.split(" ").filter((t) => t.length >= 3);

/** ¿Dos palabras son la misma, permitiendo truncado del banco y una errata? */
function palabraCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  // Truncado: el banco cortó el apellido a la mitad («PERE» de «PEREZ»).
  if (corta.length >= 4 && larga.startsWith(corta) && larga.length - corta.length <= 2) return true;
  // Una letra de diferencia, sólo en palabras largas: «MENESES»/«MENESSES».
  // En palabras cortas una letra cambia el nombre entero (ANA/ANO, LUIS/LUZ).
  if (corta.length >= 6 && Math.abs(a.length - b.length) <= 1 && distancia1(a, b)) return true;
  return false;
}

/** ¿Difieren en a lo más una edición (sustitución, inserción o borrado)? */
function distancia1(a: string, b: string): boolean {
  if (a === b) return true;
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  if (larga.length - corta.length > 1) return false;
  let i = 0, j = 0, ediciones = 0;
  while (i < corta.length && j < larga.length) {
    if (corta[i] === larga[j]) { i++; j++; continue; }
    if (++ediciones > 1) return false;
    if (corta.length === larga.length) { i++; j++; } else { j++; }
  }
  return ediciones + (larga.length - j) + (corta.length - i) <= 1;
}

/**
 * El token que IDENTIFICA a una contraparte bancaria, para buscar sus facturas
 * con un `contains` en SQL: el más largo del nombre normalizado (sin sufijos
 * societarios), con piso de 4 letras. "ZIONX SA DE CV" → "ZIONX";
 * "MARIA AMPARO ALONSO SOBERON" → "SOBERON". Devuelve null cuando no hay
 * token con el que un contains no traiga medio padrón.
 */
export function tokenIdentificante(nombre: string | null | undefined): string | null {
  const tokens = normalizarNombre(nombre ?? "")
    .split(" ")
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t));
  if (tokens.length === 0) return null;
  return tokens.reduce((mejor, t) => (t.length > mejor.length ? t : mejor), tokens[0]);
}
