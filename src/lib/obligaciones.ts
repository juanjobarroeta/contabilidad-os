// ─────────────────────────────────────────────────────────────────────────────
// Mexican fiscal obligations — static régimen map + due date calculator + CSF parser
//
// This module is PURE (no prisma/IO) so it can be imported from client
// components too. The DB seeding lives in obligaciones-seed.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface ObligacionConfig {
  tipo: string;
  descripcion: string;
  periodicidad: "MENSUAL" | "BIMESTRAL" | "ANUAL";
  diaVencimiento: number;  // day of month (17 for most monthly/bimonthly)
  mesVencimiento?: number; // for ANUAL: 3=March (PM), 4=April (PF)
}

export interface RegimenInfo {
  nombre: string;
  obligaciones: ObligacionConfig[];
}

// ── SAT Mexican official holidays (fixed-date only; movable ones shift to Monday by law) ──
const HOLIDAYS: [number, number][] = [
  [1, 1],   // Año Nuevo
  [2, 5],   // Constitución (movable Monday — for simplicity we skip the shift)
  [3, 21],  // Natalicio Juárez (movable Monday)
  [5, 1],   // Día del Trabajo
  [9, 16],  // Independencia
  [11, 20], // Revolución (movable Monday)
  [12, 25], // Navidad
];

function isWeekendOrHoliday(date: Date): boolean {
  const day = date.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return true;
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return HOLIDAYS.some(([hm, hd]) => hm === m && hd === d);
}

/** Returns the next business day on or after `date` */
export function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  while (isWeekendOrHoliday(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Calculate the due date for a given obligation and period.
 * periodo: "2026-04" for monthly, "2026-B2" for bimonthly, "2026" for annual
 */
export function calcularVencimiento(ob: ObligacionConfig, periodo: string): Date {
  if (ob.periodicidad === "ANUAL") {
    const y = parseInt(periodo);
    // Annual ISR: March 31 (PM) or April 30 (PF) of the FOLLOWING year
    const mes = ob.mesVencimiento ?? 3;
    const raw = new Date(y + 1, mes - 1, ob.diaVencimiento);
    return nextBusinessDay(raw);
  }

  if (ob.periodicidad === "BIMESTRAL") {
    // periodo = "2026-B1" (Jan-Feb), "2026-B2" (Mar-Apr), etc.
    const [yearStr, bStr] = periodo.split("-B");
    const bNum = parseInt(bStr); // 1-6
    const month = bNum * 2; // last month of the bimester (Feb=2, Apr=4, ...)
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? parseInt(yearStr) + 1 : parseInt(yearStr);
    const raw = new Date(nextYear, nextMonth - 1, ob.diaVencimiento);
    return nextBusinessDay(raw);
  }

  // MENSUAL: periodo = "2026-04" → due on day 17 of May 2026
  const [yearStr, monthStr] = periodo.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr); // 1-12
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const raw = new Date(nextYear, nextMonth - 1, ob.diaVencimiento);
  return nextBusinessDay(raw);
}

// ── Régimen → obligations map ─────────────────────────────────────────────────
export const REGIMEN_MAP: Record<string, RegimenInfo> = {
  "601": {
    nombre: "General de Ley Personas Morales",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                      periodicidad: "MENSUAL",  diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",           periodicidad: "MENSUAL",  diaVencimiento: 17 },
      { tipo: "DIOT",             descripcion: "DIOT mensual",                      periodicidad: "MENSUAL",  diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (personas morales)", periodicidad: "ANUAL", diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "603": {
    nombre: "Personas Morales con Fines no Lucrativos",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "RETENCIONES_ISR",  descripcion: "Retenciones de ISR",                periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio",                  periodicidad: "ANUAL",  diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "605": {
    nombre: "Sueldos y Salarios e Ingresos Asimilados a Salarios",
    obligaciones: [
      { tipo: "RETENCIONES_ISR",  descripcion: "Retenciones de ISR por salarios",   periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "606": {
    nombre: "Arrendamiento",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "608": {
    nombre: "Demás Ingresos",
    obligaciones: [
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "610": {
    nombre: "Residentes en el Extranjero sin Establecimiento Permanente en México",
    obligaciones: [
      { tipo: "RETENCIONES_ISR",  descripcion: "Retenciones de ISR a residentes extranjeros", periodicidad: "MENSUAL", diaVencimiento: 17 },
    ],
  },
  "611": {
    nombre: "Ingresos por Dividendos",
    obligaciones: [
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "612": {
    nombre: "Personas Físicas con Actividades Empresariales y Profesionales",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "DIOT",             descripcion: "DIOT mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "614": {
    nombre: "Ingresos por Intereses",
    obligaciones: [
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (PF)",             periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
  "616": {
    nombre: "Sin Obligaciones Fiscales",
    obligaciones: [],
  },
  "620": {
    nombre: "Sociedades Cooperativas de Producción",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio",                  periodicidad: "ANUAL",  diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "621": {
    nombre: "Incorporación Fiscal",
    obligaciones: [
      { tipo: "IVA_BIMESTRAL",    descripcion: "IVA bimestral (RIF)",               periodicidad: "BIMESTRAL", diaVencimiento: 17 },
      { tipo: "ISR_BIMESTRAL",    descripcion: "ISR bimestral (RIF)",               periodicidad: "BIMESTRAL", diaVencimiento: 17 },
    ],
  },
  "622": {
    nombre: "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio",                  periodicidad: "ANUAL",  diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "623": {
    nombre: "Opcional para Grupos de Sociedades",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio",                  periodicidad: "ANUAL",  diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "624": {
    nombre: "Coordinados",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual",                       periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR pagos provisionales",            periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio",                  periodicidad: "ANUAL",  diaVencimiento: 31, mesVencimiento: 3 },
    ],
  },
  "626": {
    nombre: "Régimen Simplificado de Confianza (RESICO)",
    obligaciones: [
      { tipo: "IVA_MENSUAL",      descripcion: "IVA mensual (RESICO)",              periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_PROVISIONAL",  descripcion: "ISR simplificado mensual (RESICO)", periodicidad: "MENSUAL", diaVencimiento: 17 },
      { tipo: "ISR_ANUAL",        descripcion: "ISR del ejercicio (RESICO)",         periodicidad: "ANUAL",  diaVencimiento: 30, mesVencimiento: 4 },
    ],
  },
};

/** Get obligations for a régimen code. Falls back to empty array for unknown codes. */
export function getObligacionesPorRegimen(regimenFiscal: string): ObligacionConfig[] {
  // Some companies have multiple regimes stored as comma-separated codes
  const codes = regimenFiscal.split(",").map(c => c.trim());
  const seen = new Set<string>();
  const result: ObligacionConfig[] = [];
  for (const code of codes) {
    for (const ob of REGIMEN_MAP[code]?.obligaciones ?? []) {
      if (!seen.has(ob.tipo)) {
        seen.add(ob.tipo);
        result.push(ob);
      }
    }
  }
  return result;
}

// ── CSF PDF parser ────────────────────────────────────────────────────────────
export interface CsfData {
  rfc?: string;
  razonSocial?: string;
  codigoPostal?: string;
  regimenFiscal?: string;   // primary (first one found)
  regimenes: Array<{ codigo: string; nombre: string; desde: string }>;
  obligaciones: Array<{
    descripcion: string;
    periodicidad: string;
    desde: string;
  }>;
}

/**
 * Parse raw text extracted from a SAT Constancia de Situación Fiscal PDF.
 * The CSF has consistent section headers that we can anchor on.
 */
export function parsearTextoCsf(text: string): CsfData {
  const result: CsfData = { regimenes: [], obligaciones: [] };

  // Normalize: collapse multiple spaces/tabs, split into lines
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  // ── RFC ──────────────────────────────────────────────────────────────────
  const rfcMatch = text.match(/RFC[:\s]+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
  if (rfcMatch) result.rfc = rfcMatch[1].toUpperCase();

  // ── Razón Social ─────────────────────────────────────────────────────────
  const razonIdx = lines.findIndex(l => /raz[oó]n social|nombre del contribuyente/i.test(l));
  if (razonIdx >= 0 && razonIdx + 1 < lines.length) {
    result.razonSocial = lines[razonIdx + 1];
  }

  // ── Código postal ────────────────────────────────────────────────────────
  const cpMatch = text.match(/[Cc][Óó]digo [Pp]ostal[:\s]+(\d{5})/);
  if (cpMatch) result.codigoPostal = cpMatch[1];

  // ── Regímenes ────────────────────────────────────────────────────────────
  // The CSF lists regimes in a table; we look for lines that match a known regime code
  const regimenCodes = Object.keys(REGIMEN_MAP);
  const regimenSection = text.match(/RÉGIMENES?\s*FISCALES?([\s\S]*?)(?:ACTIVIDADES|OBLIGACIONES|$)/i);
  if (regimenSection) {
    const block = regimenSection[1];
    for (const code of regimenCodes) {
      // Match lines like "601   General de Ley Personas Morales   01/01/2020"
      const re = new RegExp(`\\b${code}\\b([^\\n]+)?`, "i");
      const m = block.match(re);
      if (m) {
        const nombre = REGIMEN_MAP[code]?.nombre ?? m[1]?.trim() ?? code;
        // Try to find a date near the code match
        const dateMatch = m[0].match(/\d{2}\/\d{2}\/\d{4}/);
        result.regimenes.push({ codigo: code, nombre, desde: dateMatch?.[0] ?? "" });
        if (!result.regimenFiscal) result.regimenFiscal = code;
      }
    }
  }

  // Fallback: look for standalone regime code pattern anywhere
  if (result.regimenes.length === 0) {
    for (const code of regimenCodes) {
      if (text.includes(code)) {
        result.regimenes.push({ codigo: code, nombre: REGIMEN_MAP[code]?.nombre ?? code, desde: "" });
        if (!result.regimenFiscal) result.regimenFiscal = code;
      }
    }
  }

  // ── Obligaciones section ─────────────────────────────────────────────────
  const obligSection = text.match(/OBLIGACIONES\s*([\s\S]*?)(?:ACTIVIDAD|TELÉFONO|$)/i);
  if (obligSection) {
    const block = obligSection[1];
    const periodPattern = /mensual|bimestral|anual|trimestral|semestral/gi;
    const blockLines = block.split("\n").map(l => l.trim()).filter(Boolean);

    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      const periodicidadMatch = line.match(periodPattern);
      if (periodicidadMatch) {
        // The obligation description is usually on the line(s) before the periodicity
        const desc = blockLines[i - 1] ?? line;
        const dateMatch = (blockLines[i + 1] ?? "").match(/\d{2}\/\d{2}\/\d{4}/);
        result.obligaciones.push({
          descripcion: desc.length > 5 ? desc : line,
          periodicidad: periodicidadMatch[0].toLowerCase(),
          desde: dateMatch?.[0] ?? "",
        });
      }
    }
  }

  return result;
}

// ── Obligation seeding engine ─────────────────────────────────────────────────

export const TIPO_DESC: Record<string, string> = {
  IVA_MENSUAL: "IVA mensual",
  IVA_BIMESTRAL: "IVA bimestral",
  ISR_PROVISIONAL: "ISR pagos provisionales",
  ISR_BIMESTRAL: "ISR bimestral",
  ISR_ANUAL: "ISR del ejercicio",
  DIOT: "DIOT mensual",
  RETENCIONES_ISR: "Retenciones de ISR",
  // Cuotas IMSS (SIPARE) — no derivan del régimen SAT sino de tener nómina:
  // obrero-patronales mensuales y RCV + Infonavit bimestrales (LSS Art. 39),
  // ambas con vencimiento el día 17 (defaultConfigForTipo ya las resuelve).
  IMSS_MENSUAL: "Cuotas IMSS mensuales (SIPARE)",
  IMSS_BIMESTRAL: "RCV e Infonavit bimestral (SIPARE)",
};

/** Best-effort config for an obligation tipo not present in the régimen map. */
export function defaultConfigForTipo(tipo: string): ObligacionConfig {
  const descripcion = TIPO_DESC[tipo] ?? tipo;
  if (tipo.endsWith("ANUAL")) {
    // Default to the PF deadline (Apr 30); PM (Mar 31) comes from the régimen map.
    return { tipo, descripcion, periodicidad: "ANUAL", diaVencimiento: 30, mesVencimiento: 4 };
  }
  if (tipo.includes("BIMESTRAL")) {
    return { tipo, descripcion, periodicidad: "BIMESTRAL", diaVencimiento: 17 };
  }
  return { tipo, descripcion, periodicidad: "MENSUAL", diaVencimiento: 17 };
}

/**
 * Map a CSF obligation description to our internal obligation tipo.
 * Returns null if no match found.
 */
export function mapCsfObligacion(descripcion: string): string | null {
  const d = descripcion.toLowerCase();
  // DIOT FIRST: the SAT labels it "Declaración de proveedores de IVA", which
  // contains "iva" — so it must be caught before the IVA branch below.
  if (d.includes("diot") || d.includes("operaciones con terceros") || d.includes("proveedores")) {
    return "DIOT";
  }
  if (d.includes("valor agregado") || /\biva\b/.test(d)) {
    if (d.includes("bimestral")) return "IVA_BIMESTRAL";
    return "IVA_MENSUAL";
  }
  if (d.includes("renta") || /\bisr\b/.test(d) || d.includes("pago provisional") || d.includes("pagos provisionales")) {
    if (d.includes("bimestral")) return "ISR_BIMESTRAL";
    if (d.includes("ejercicio") || d.includes("anual")) return "ISR_ANUAL";
    return "ISR_PROVISIONAL";
  }
  if (d.includes("retenci")) return "RETENCIONES_ISR";
  if (d.includes("declaraci") && d.includes("anual")) return "ISR_ANUAL";
  return null;
}
