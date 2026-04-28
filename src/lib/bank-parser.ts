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
  format: "csv" | "ofx" | "spreadsheetml";
  detectedBank?: string;
  warnings: string[];
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function parseStatement(content: string, filename: string): ParseResult {
  const clean = content.replace(/^\uFEFF/, "").trim(); // strip BOM

  // OFX / QFX
  if (
    clean.includes("<OFX>") ||
    clean.includes("<STMTTRN>") ||
    filename.toLowerCase().endsWith(".ofx") ||
    filename.toLowerCase().endsWith(".qfx")
  ) {
    return parseOFX(clean);
  }

  // SpreadsheetML 2003 — BBVA "RSM" exports save as .xls but are XML
  if (
    clean.includes("urn:schemas-microsoft-com:office:spreadsheet") ||
    clean.includes("<Workbook") ||
    clean.includes("mso-application")
  ) {
    return parseSpreadsheetML(clean);
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

  // 1. Detect separator (scan multiple lines — header may not be on line 1)
  const sep = detectSeparator(content);

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

  // 3. Find the header row (scan up to 25 rows — Banamex has 16 summary lines)
  // Must contain a date keyword AND an amount keyword to avoid matching section titles
  let headerIdx = 0;
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i].join(" ").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const hasDate = /fecha|date|fch/.test(row);
    const hasAmount = /monto|cargo|abono|importe|deposito|retiro|movimiento|descripci|concepto/.test(row);
    if (hasDate && hasAmount) {
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
  const debitCol   = detectCol(headers, ["cargo", "debito", "egreso", "retiro", "retiros", "debe"]);
  const creditCol  = detectCol(headers, ["abono", "credito", "ingreso", "deposito", "depositos", "haber"]);
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
      // NaN means empty cell (e.g. "-" or blank) — treat as 0
      const creditVal = isNaN(credit) ? 0 : credit;
      const debitVal  = isNaN(debit)  ? 0 : debit;
      // credit is positive, debit is negative
      monto = creditVal !== 0 ? Math.abs(creditVal) : -Math.abs(debitVal);
    }

    if (isNaN(monto) || monto === 0) continue;

    // Extract description
    let desc = descCol >= 0 ? (row[descCol] ?? "") : row.join(" ");
    desc = desc.replace(/\s+/g, " ").trim();

    // Auto-extract reference from Banamex descriptions (embedded "Referencia Numérica: XXXX")
    let ref = refCol >= 0 ? row[refCol] : undefined;
    if (!ref) {
      const refMatch = desc.match(/[Rr]eferencia\s+[Nn].{0,10}?:\s*(\S+)/);
      if (refMatch) ref = refMatch[1].replace(/^0+/, "") || refMatch[1]; // strip leading zeros
    }

    transactions.push({
      fecha,
      descripcion: desc,
      monto,
      referencia: ref?.trim() || undefined,
      saldo: balanceCol >= 0 ? parseMXNumber(row[balanceCol] ?? "") : undefined,
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

// ── SpreadsheetML 2003 parser (BBVA RSM "Banca Net Cash" exports) ──────────
// Excel XML format. Each <Row> has <Cell><Data>...</Data></Cell> children.
function parseSpreadsheetML(content: string): ParseResult {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Detect bank from author/company metadata
  let detectedBank: string | undefined;
  if (/bbva|bancomer/i.test(content)) detectedBank = "BBVA";
  else if (/banamex|citibanamex/i.test(content)) detectedBank = "Banamex";

  // Extract <Row>...</Row> blocks
  const rowRegex = /<Row[^>]*>([\s\S]*?)<\/Row>/gi;
  const rows: string[][] = [];
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(content)) !== null) {
    const rowXml = match[1];
    const cells: string[] = [];

    // Each <Cell> may have ss:Index="N" to skip columns; honor that for alignment
    const cellRegex = /<Cell([^>]*)>([\s\S]*?)<\/Cell>/gi;
    let cellMatch: RegExpExecArray | null;
    let cursor = 0;

    while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];

      // Honor ss:Index="N" — pad missing cells with empty strings
      const idxMatch = attrs.match(/ss:Index="(\d+)"/i);
      if (idxMatch) {
        const targetIdx = parseInt(idxMatch[1]) - 1;
        while (cursor < targetIdx) { cells.push(""); cursor++; }
      }

      // Extract the text inside <Data ...>...</Data>
      const dataMatch = inner.match(/<Data[^>]*>([\s\S]*?)<\/Data>/i);
      const value = dataMatch ? dataMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      cells.push(value);
      cursor++;
    }
    rows.push(cells);
  }

  if (rows.length < 2) {
    return { transactions: [], format: "spreadsheetml", warnings: ["Archivo XLS sin filas suficientes"], detectedBank };
  }

  // Find header row — look for "Fecha" + amount keyword
  let headerIdx = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const joined = rows[i].join(" ").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (/fecha/.test(joined) && /(cargo|abono|monto|importe|deposito|retiro)/.test(joined)) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx < 0) {
    return { transactions: [], format: "spreadsheetml", warnings: ["No se encontró fila de encabezados"], detectedBank };
  }

  const headers = rows[headerIdx].map(h =>
    h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()
  );

  const dateCol    = detectCol(headers, ["fecha", "date", "fch"]);
  const descCol    = detectCol(headers, ["concepto", "descripcion", "movimiento", "detalle"]);
  const amountCol  = detectCol(headers, ["monto", "importe"]);
  const debitCol   = detectCol(headers, ["cargo", "debito", "egreso", "retiro"]);
  const creditCol  = detectCol(headers, ["abono", "credito", "ingreso", "deposito"]);
  const balanceCol = detectCol(headers, ["saldo", "balance"]);
  const refCol     = detectCol(headers, ["referencia", "folio"]);

  if (dateCol < 0) {
    return { transactions: [], format: "spreadsheetml", warnings: ["Sin columna de fecha"], detectedBank };
  }

  for (const row of rows.slice(headerIdx + 1)) {
    if (row.every(c => !c)) continue;

    const fecha = parseDateMX(row[dateCol] ?? "");
    if (!fecha) continue;

    let monto: number;
    if (amountCol >= 0) {
      monto = parseMXNumber(row[amountCol] ?? "");
    } else {
      const credit = parseMXNumber(row[creditCol] ?? "");
      const debit  = parseMXNumber(row[debitCol] ?? "");
      const creditVal = isNaN(credit) ? 0 : credit;
      const debitVal  = isNaN(debit)  ? 0 : debit;
      monto = creditVal !== 0 ? Math.abs(creditVal) : -Math.abs(debitVal);
    }

    if (isNaN(monto) || monto === 0) continue;

    const desc = (descCol >= 0 ? (row[descCol] ?? "") : row.join(" ")).replace(/\s+/g, " ").trim();
    let ref = refCol >= 0 ? row[refCol] : undefined;

    // Combine reference + reference ampliada if both exist
    const refAmpCol = headers.findIndex(h => h.includes("ampliada"));
    if (refAmpCol >= 0 && row[refAmpCol]) {
      ref = ref ? `${ref} ${row[refAmpCol]}` : row[refAmpCol];
    }

    transactions.push({
      fecha,
      descripcion: desc,
      monto,
      referencia: ref?.trim() || undefined,
      saldo: balanceCol >= 0 ? parseMXNumber(row[balanceCol] ?? "") : undefined,
    });
  }

  return { transactions, format: "spreadsheetml", detectedBank, warnings };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectSeparator(content: string): string {
  // Sample first 30 lines (not just the first — header may be deep in the file)
  const sample = content.split("\n").slice(0, 30).join("\n");
  const counts = {
    ";": (sample.match(/;/g) ?? []).length,
    ",": (sample.match(/,/g) ?? []).length,
    "|": (sample.match(/\|/g) ?? []).length,
    "\t": (sample.match(/\t/g) ?? []).length,
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
  if (c.includes("banamex") || c.includes("citibanamex") || c.includes("cuenta cheques"))    return "Banamex";
  if (c.includes("santander") || h.includes("sucursal"))       return "Santander";
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
