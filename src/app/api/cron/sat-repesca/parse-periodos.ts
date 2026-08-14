// Vive fuera de `route.ts` porque Next.js valida los exports de un route
// handler y rechaza cualquiera que no sea suyo (`"parsePeriodos" is not a valid
// Route export field`). `tsc --noEmit` no lo ve; sólo `next build`.

/** "2025-04,2023-08" → [{año,mes}]. Ignora lo que no parsea, sin adivinar. */
export function parsePeriodos(raw: string): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (const tok of raw.split(",")) {
    const m = tok.trim().match(/^(\d{4})-(\d{1,2})$/);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year < 2000 || year > 2100 || month < 1 || month > 12) continue;
    if (!out.some((p) => p.year === year && p.month === month)) out.push({ year, month });
  }
  return out;
}
