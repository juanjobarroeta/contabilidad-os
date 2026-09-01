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
  return x.includes(y) || y.includes(x);
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
