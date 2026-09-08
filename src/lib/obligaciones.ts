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

// ── Non-business days in CFF Article 12 ─────────────────────────────────────
const FIXED_HOLIDAYS: [number, number][] = [
  [1, 1],   // Año Nuevo
  [5, 1],   // Día del Trabajo
  [5, 5],   // Batalla de Puebla
  [9, 16],  // Independencia
  [12, 25], // Navidad
];

function isNthMonday(date: Date, month: number, nth: number): boolean {
  const day = date.getDate();
  return (
    date.getMonth() + 1 === month &&
    date.getDay() === 1 &&
    day >= (nth - 1) * 7 + 1 &&
    day <= nth * 7
  );
}

/** Calendar non-business day for federal tax deadlines under CFF Article 12. */
export function esDiaInhabilCff(date: Date): boolean {
  const day = date.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return true;
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (FIXED_HOLIDAYS.some(([hm, hd]) => hm === m && hd === d)) return true;

  // The statute names the observed Mondays, not February 5, March 21, and
  // November 20 themselves.
  if (isNthMonday(date, 2, 1)) return true;
  if (isNthMonday(date, 3, 3)) return true;
  if (isNthMonday(date, 11, 3)) return true;

  // Current CFF text also lists December 1 every six years for transfer of the
  // Federal Executive. 2018 is the reference transfer year.
  return m === 12 && d === 1 && (date.getFullYear() - 2018) % 6 === 0;
}

/** Returns the next business day on or after `date` */
export function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  while (esDiaInhabilCff(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Add business days strictly after a calendar date. */
export function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date);
  let remaining = Math.max(0, Math.trunc(days));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!esDiaInhabilCff(d)) remaining -= 1;
  }
  return d;
}

/**
 * RMF/SAT deadline facility derived from the sixth numeric RFC digit.
 * Returns null for an invalid RFC. Applicability is taxpayer/obligation
 * specific; callers must opt in instead of applying this value globally.
 */
export function diasHabilesExtraPorRfc(rfc: string): number | null {
  const match = rfc.trim().toUpperCase().match(/^[A-ZÑ&]{3,4}(\d{6})[A-Z0-9]{3}$/);
  if (!match) return null;
  const sixthDigit = Number(match[1][5]);
  if (sixthDigit === 1 || sixthDigit === 2) return 1;
  if (sixthDigit === 3 || sixthDigit === 4) return 2;
  if (sixthDigit === 5 || sixthDigit === 6) return 3;
  if (sixthDigit === 7 || sixthDigit === 8) return 4;
  return 5; // 9 or 0
}

export interface VencimientoOptions {
  /** Explicit only after the obligation/taxpayer has been found eligible. */
  diasHabilesAdicionales?: number;
}

/** Serialize a calendar deadline without converting it to an instant/timezone. */
export function fechaCalendarioIso(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Calculate the due date for a given obligation and period.
 * periodo: "2026-04" for monthly, "2026-B2" for bimonthly, "2026" for annual
 */
export function calcularVencimiento(
  ob: ObligacionConfig,
  periodo: string,
  options: VencimientoOptions = {},
): Date {
  let raw: Date;
  if (ob.periodicidad === "ANUAL") {
    const y = parseInt(periodo);
    // Annual ISR: March 31 (PM) or April 30 (PF) of the FOLLOWING year
    const mes = ob.mesVencimiento ?? 3;
    raw = new Date(y + 1, mes - 1, ob.diaVencimiento);
    return nextBusinessDay(raw);
  }

  if (ob.periodicidad === "BIMESTRAL") {
    // periodo = "2026-B1" (Jan-Feb), "2026-B2" (Mar-Apr), etc.
    const [yearStr, bStr] = periodo.split("-B");
    const bNum = parseInt(bStr); // 1-6
    const month = bNum * 2; // last month of the bimester (Feb=2, Apr=4, ...)
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? parseInt(yearStr) + 1 : parseInt(yearStr);
    raw = new Date(nextYear, nextMonth - 1, ob.diaVencimiento);
  } else {
    // MENSUAL: periodo = "2026-04" → due on day 17 of May 2026
    const [yearStr, monthStr] = periodo.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr); // 1-12
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    raw = new Date(nextYear, nextMonth - 1, ob.diaVencimiento);
  }

  const extraDays = Math.max(0, Math.trunc(options.diasHabilesAdicionales ?? 0));
  // The facility says "day 17 plus N business days". If the 17th is a
  // weekend, Monday is the first extra business day—not the adjusted base plus
  // another day. Without the facility, normal CFF next-business-day applies.
  return extraDays > 0 ? addBusinessDays(raw, extraDays) : nextBusinessDay(raw);
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
  // IEPS definitivo mensual (Art. 5o LIEPS, día 17 — defaultConfigForTipo ya lo
  // resuelve como MENSUAL). Por ahora se captura del acuse; el motor va después.
  IEPS_MENSUAL: "IEPS mensual",
  // Cuotas IMSS (SIPARE) — no derivan del régimen SAT sino de tener nómina:
  // obrero-patronales mensuales y RCV + Infonavit bimestrales (LSS Art. 39),
  // ambas con vencimiento el día 17 (defaultConfigForTipo ya las resuelve).
  IMSS_MENSUAL: "Cuotas IMSS mensuales (SIPARE)",
  IMSS_BIMESTRAL: "RCV e Infonavit bimestral (SIPARE)",
  // ISN — ESTATAL, no lo cobra el SAT. Como el IMSS, no deriva del régimen del
  // SAT sino de tener nómina: lo causa quien paga remuneraciones, en el estado
  // donde se presta el servicio. Día 17 en la mayoría de los estados.
  ISN_MENSUAL: "ISN (impuesto sobre nóminas)",
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
  // IEPS antes que ISR: sus descripciones ("Declaración mensual del impuesto
  // especial sobre producción y servicios…") no mencionan IVA/ISR, pero sí
  // pueden traer "pago definitivo" que otras ramas no deben capturar.
  if (/\bieps\b/.test(d) || d.includes("producción y servicios") || d.includes("produccion y servicios")) {
    return "IEPS_MENSUAL";
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
