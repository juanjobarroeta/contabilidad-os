// ─────────────────────────────────────────────────────────────────────────────
// Bank statement parser — handles CSV (all separators) and OFX/QFX
// Designed for Mexican banks: BBVA, Banamex, Santander, Banorte, HSBC, etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedTransaction {
  fecha: Date;
  descripcion: string;
  monto: number;    // positive = credit, negative = debit
  referencia?: string;
  saldo?: number;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  format: "csv" | "ofx";
  detectedBank?: string;
  warnings: string[];
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function parseStatement(content: string, filename: string): ParseResult {
  const clean = content.replace(/^\uFEFF/, "").trim(); // strip BOM

  if (
    clean.includes("<OFX>") ||
    clean.includes("<STMTTRN>") ||
    filename.toLowerCase().endsWith(".ofx") ||
    filename.toLowerCase().endsWith(".qfx")
  ) {
    return parseOFX(clean);
  }
  return parseCSV(clean);
}

// ── OFX / QFX parser ──────────────────────────────────────────────────────────
function parseOFX(content: string): ParseResult {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Handle both SGML (old OFX) and XML (new OFX) formats
  const trnRegex = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi;
  let match: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((match = trnRegex.exec(content)) !== null) {
    const block = match[1];
    const amtStr  = extractOFXTag(block, "TRNAMT");
    const dateStr = extractOFXTag(block, "DTPOSTED");
    const memo    = extractOFXTag(block, "MEMO") ?? extractOFXTag(block, "NAME") ?? "";
    const fitid   = extractOFXTag(block, "FITID");

    if (!amtStr || !dateStr) continue;

    const fecha = parseOFXDate(dateStr);
    if (!fecha) { warnings.push(`Fecha inválida: ${dateStr}`); continue; }

    transactions.push({
      fecha,
      descripcion: memo.trim(),
      monto: parseFloat(amtStr.replace(",", ".")),
      referencia: fitid ?? undefined,
    });
  }

  return { transactions, format: "ofx", warnings };
}

function extractOFXTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<\\n\\r]+)`, "i");
  return block.match(re)?.[1]?.trim() ?? null;
}

function parseOFXDate(s: string): Date | null {
  // YYYYMMDD or YYYYMMDDHHMMSS[.mmm][±hhmm]
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(content: string): ParseResult {
  const warnings: string[] = [];

  // 1. Detect separator
  const firstLine = content.split("\n")[0];
  const sep = detectSeparator(firstLine);

  // 2. Parse into 2-D array (handle quoted fields)
  const rows = splitCSV(content, sep)
    .map(row => row.map(cell => cell.trim().replace(/^["']|["']$/g, "")));

  if (rows.length < 2) {
    return { transactions: [], format: "csv", warnings: ["El archivo no tiene suficientes filas"] };
  }

  // 2.5 — Banco del Bajío has no header row. First row is "Saldo Inicial",
  // subsequent rows are: cuenta, fecha, id1, referencia, descripcion, num,
  // cargo, abono, saldo, id2. Detect by "Saldo Inicial" in row 0.
  if (rows[0]?.some(c => c.toLowerCase().includes("saldo inicial"))) {
    return parseBajio(rows, warnings);
  }

  // 3. Find the header row (first row that contains recognisable column names)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i].join(" ").toLowerCase();
    if (/fecha|date|descripci|concepto|movimiento|monto|cargo|abono|importe/.test(row)) {
      headerIdx = i;
      break;
    }
  }

  const headers = rows[headerIdx].map(h => h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim());
  const detectedBank = detectBank(headers, content);

  // 4. Detect columns
  const dateCol    = detectCol(headers, ["fecha", "date", "fecha de operacion", "fch"]);
  const descCol    = detectCol(headers, ["descripcion", "descripci", "concepto", "movimiento", "referencia", "detalle", "memo"]);
  const amountCol  = detectCol(headers, ["monto", "importe", "amount", "movimiento"]);
  const debitCol   = detectCol(headers, ["cargo", "debito", "egreso", "retiro", "debe"]);
  const creditCol  = detectCol(headers, ["abono", "credito", "ingreso", "deposito", "haber"]);
  const balanceCol = detectCol(headers, ["saldo", "balance", "disponible"]);
  const refCol     = detectCol(headers, ["referencia", "folio", "num operacion", "id", "fitid"]);

  if (dateCol < 0) {
    warnings.push("No se encontró columna de fecha. Verifica el formato del archivo.");
    return { transactions: [], format: "csv", warnings, detectedBank };
  }
  if (amountCol < 0 && (debitCol < 0 || creditCol < 0)) {
    warnings.push("No se encontró columna de monto. Verifica el formato del archivo.");
    return { transactions: [], format: "csv", warnings, detectedBank };
  }

  // 5. Parse data rows
  const transactions: ParsedTransaction[] = [];
  const dataRows = rows.slice(headerIdx + 1);

  for (const row of dataRows) {
    if (row.every(c => !c)) continue; // blank row

    const fecha = parseDateMX(row[dateCol] ?? "");
    if (!fecha) continue;

    let monto: number;
    if (amountCol >= 0) {
      monto = parseMXNumber(row[amountCol] ?? "");
    } else {
      const credit = parseMXNumber(row[creditCol] ?? "");
      const debit  = parseMXNumber(row[debitCol] ?? "");
      // credit is positive, debit is negative
      monto = credit !== 0 ? Math.abs(credit) : -Math.abs(debit);
    }

    if (isNaN(monto) || monto === 0) continue;

    transactions.push({
      fecha,
      descripcion: descCol >= 0 ? (row[descCol] ?? "") : row.join(" "),
      monto,
      referencia:  refCol >= 0    ? row[refCol]    : undefined,
      saldo:       balanceCol >= 0 ? parseMXNumber(row[balanceCol] ?? "") : undefined,
    });
  }

  return { transactions, format: "csv", detectedBank, warnings };
}

// ── Banco del Bajío (no header row, fixed columns) ───────────────────────────
function parseBajio(rows: string[][], warnings: string[]): ParseResult {
  const transactions: ParsedTransaction[] = [];
  // Skip row 0 (Saldo Inicial). Layout per row:
  //   0=cuenta 1=fecha 2=id1 3=referencia 4=descripcion 5=num 6=cargo 7=abono 8=saldo 9=id2
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => !c)) continue;

    const fecha = parseDateMX(row[1] ?? "");
    if (!fecha) continue;

    const cargo = parseMXNumber(row[6] ?? "");
    const abono = parseMXNumber(row[7] ?? "");
    const monto = abono !== 0 ? Math.abs(abono) : -Math.abs(cargo);
    if (monto === 0) continue;

    transactions.push({
      fecha,
      descripcion: (row[4] ?? "").replace(/\s+/g, " ").trim(),
      monto,
      referencia: row[3]?.trim() || undefined,
      saldo: parseMXNumber(row[8] ?? "") || undefined,
    });
  }

  return {
    transactions,
    format: "csv",
    detectedBank: "Banco del Bajío",
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectSeparator(line: string): string {
  const counts = {
    ";": (line.match(/;/g) ?? []).length,
    ",": (line.match(/,/g) ?? []).length,
    "|": (line.match(/\|/g) ?? []).length,
    "\t": (line.match(/\t/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function splitCSV(content: string, sep: string): string[][] {
  return content.split("\n").map(line => {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === sep && !inQuote) { cells.push(cur); cur = ""; }
      else { cur += ch; }
    }
    cells.push(cur);
    return cells;
  });
}

function detectCol(headers: string[], keywords: string[]): number {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => h.includes(kw));
    if (idx >= 0) return idx;
  }
  return -1;
}

function detectBank(headers: string[], content: string): string | undefined {
  const h = headers.join(" ");
  const c = content.substring(0, 500).toLowerCase();
  if (c.includes("bbva") || h.includes("num de referencia")) return "BBVA";
  if (c.includes("banamex") || c.includes("citibanamex"))    return "Banamex";
  if (c.includes("santander"))                                return "Santander";
  if (c.includes("banorte"))                                  return "Banorte";
  if (c.includes("hsbc"))                                     return "HSBC";
  if (c.includes("scotiabank"))                               return "Scotiabank";
  return undefined;
}

/** Parse Mexican date formats: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YYYY, etc.
 *  Stored at UTC noon so display in any TZ from UTC-11 to UTC+11 stays
 *  on the same calendar day. */
function utcNoon(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0));
}

function parseDateMX(s: string): Date | null {
  const clean = s.trim();
  // DD/MM/YYYY or DD-MM-YYYY
  let m = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return utcNoon(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  // YYYY-MM-DD or YYYY/MM/DD
  m = clean.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (m) return utcNoon(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // DD-MMM-YYYY (e.g. 13-Mar-2026)
  const months: Record<string, number> = {
    ene:0,feb:1,mar:2,abr:3,may:4,jun:5,
    jul:6,ago:7,sep:8,oct:9,nov:10,dic:11,
    jan:0,apr:3,aug:7,dec:11,
  };
  m = clean.match(/^(\d{1,2})[\/\-\s]([a-zA-Z]{3})[\/\-\s](\d{4})$/);
  if (m) {
    const mo = months[m[2].toLowerCase()];
    if (mo !== undefined) return utcNoon(parseInt(m[3]), mo, parseInt(m[1]));
  }
  return null;
}

/** Parse Mexican number format: 1,234,567.89 or 1.234.567,89 */
function parseMXNumber(s: string): number {
  const clean = s.replace(/\s/g, "").replace(/[$MXN]/gi, "");
  if (!clean) return 0;
  // Detect comma-as-decimal (European style): 1.234,56
  if (/\.\d{3},/.test(clean) || clean.match(/,\d{2}$/)) {
    return parseFloat(clean.replace(/\./g, "").replace(",", "."));
  }
  // Standard: 1,234.56
  return parseFloat(clean.replace(/,/g, ""));
}
