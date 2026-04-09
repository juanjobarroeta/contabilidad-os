// ─────────────────────────────────────────────────────────────────────────────
// Tiny CSV writer with UTF-8 BOM so Excel + Numbers + Google Sheets open
// Spanish characters (ñ, á, é, í, ó, ú) correctly without a manual encoding
// selection. No external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

export type CsvRow = Array<string | number | boolean | null | undefined | Date>;

function cell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  // Quote if contains comma, quote, newline, or leading/trailing whitespace
  if (/[",\n\r]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: CsvRow[]): string {
  const lines: string[] = [];
  lines.push(headers.map(cell).join(","));
  for (const row of rows) {
    lines.push(row.map(cell).join(","));
  }
  // UTF-8 BOM so Excel detects the encoding automatically
  return "\uFEFF" + lines.join("\r\n");
}
