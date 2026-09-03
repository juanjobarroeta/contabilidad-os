// ─────────────────────────────────────────────────────────────────────────────
// Cobertura de declaraciones — detecta qué acuses (PDF) faltan por capturar para
// poder arrastrar saldos a favor, coeficiente de utilidad y pagos provisionales.
//
// Regla (acordada con el dueño):
//   • Año CERRADO  → basta la declaración ANUAL: trae el coeficiente y el
//     resultado de ISR, y cubre los mensuales de ISR de ese año. NO pedimos
//     los 12 mensuales de ISR del año cerrado.
//   • IVA no tiene anual (es definitivo mensual). Para arrastrar el saldo a
//     favor de IVA pedimos el ÚLTIMO mes del año cerrado anterior (diciembre).
//   • Año EN CURSO → pedimos los mensuales transcurridos (ISR provisional + IVA),
//     que aún no están consolidados en ninguna anual.
//   • SÓLO periodos ya VENCIDOS. Un mes cuya fecha límite (día 17 del mes
//     siguiente, en hábil) aún no pasó no "falta": está pendiente de presentar.
//     Caso real: el 3-sep el banner pedía el acuse de agosto, que vence el 17-sep.
//     Lo mismo para la anual (31-mar PM / 30-abr PF) y el diciembre previo.
//
// Es un "nag" no destructivo: en el peor caso pide un acuse de más; nunca borra.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { calcularVencimiento } from "@/lib/obligaciones";
import { esPersonaFisicaRfc, requiereDeclaracionAnual } from "@/lib/fiscal/regimen-anual";

export type TipoAcuseFaltante = "DECLARACION_ANUAL" | "ISR_PROVISIONAL" | "IVA_MENSUAL" | "IEPS_MENSUAL";

export interface AcuseFaltante {
  companyId: string;
  tipo: TipoAcuseFaltante;
  /** "2025" para anual; "2026-03" para mensual. */
  periodo: string;
  etiqueta: string;
  motivo: string;
  /**
   * True cuando el faltante afecta el arrastre del periodo en curso: la anual
   * del ejercicio INMEDIATO anterior (coeficiente), el IVA de diciembre previo
   * (saldo a favor) y los meses del año en curso. Las anuales más viejas son
   * deseables para el histórico/auditoría pero NO afectan los cálculos del mes
   * — por eso no deben disparar la alarma de "tus números están incompletos".
   */
  critico: boolean;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Máximo histórico que pedimos hacia atrás (años). El SAT permite 5. */
const MAX_ANIOS_ATRAS = 5;

/** Sólo la fecha (sin horas), para comparar días calendario. */
const soloFecha = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * ¿Ya venció la declaración mensual de `year-month`? Día 17 del mes siguiente
 * recorrido a hábil (mismo cálculo que el checklist). El propio día límite aún
 * NO está vencido. (PURA)
 */
export function mensualVencido(year: number, month: number, hoy: Date = new Date()): boolean {
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const limite = calcularVencimiento(
    { tipo: "FEDERAL", descripcion: "Declaración mensual", periodicidad: "MENSUAL", diaVencimiento: 17 },
    periodo,
  );
  return soloFecha(hoy).getTime() > soloFecha(limite).getTime();
}

/**
 * ¿Ya venció la declaración anual del `ejercicio`? Personas morales: 31 de
 * marzo del año siguiente (Art. 76-V LISR); personas físicas: 30 de abril
 * (Art. 150 LISR). El propio día límite aún NO está vencido. (PURA)
 */
export function anualVencida(ejercicio: number, esPersonaFisica: boolean, hoy: Date = new Date()): boolean {
  const limite = esPersonaFisica ? new Date(ejercicio + 1, 3, 30) : new Date(ejercicio + 1, 2, 31);
  return soloFecha(hoy).getTime() > limite.getTime();
}

/**
 * Acuses faltantes de UNA empresa. Considera obligaciones activas y la fecha de
 * inicio de operaciones para no pedir periodos previos a la existencia de la
 * empresa. Lo ya capturado (incluido lo histórico del onboarding) no se re-pide.
 */
export async function declaracionesFaltantesEmpresa(companyId: string): Promise<AcuseFaltante[]> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      rfc: true,
      regimenFiscal: true,
      fechaInicioOperaciones: true,
      isActive: true,
      obligations: { where: { activa: true }, select: { tipo: true } },
      regimenes: { select: { code: true } },
    },
  });
  if (!company || !company.isActive) return [];

  const tipos = new Set(company.obligations.map((o) => o.tipo));
  const tieneIVA = tipos.has("IVA_MENSUAL");
  const tieneISR = tipos.has("ISR_PROVISIONAL");
  // IEPS es definitivo mensual como el IVA: mismo patrón de cobertura (año en
  // curso + diciembre previo para el arrastre, que sólo compensa contra IEPS).
  const tieneIEPS = tipos.has("IEPS_MENSUAL");
  // La gran mayoría presenta anual; la pedimos para años cerrados si tiene ISR
  // (provisional o anual)… EXCEPTO cuando el régimen la exime: RESICO PF
  // (Art. 113-E, pagos definitivos) no presenta anual aunque su CSF liste la
  // obligación y aunque tenga ISR mensual. Caso real: el agente le cobró a una
  // cliente RESICO una "anual vencida" inexistente.
  const tieneAnual =
    (tieneISR || [...tipos].some((t) => t.includes("ANUAL"))) &&
    requiereDeclaracionAnual({
      regimenes: [company.regimenFiscal, ...company.regimenes.map((r) => r.code)],
      esPersonaFisica: esPersonaFisicaRfc(company.rfc),
    });
  if (!tieneIVA && !tieneISR && !tieneIEPS && !tieneAnual) return [];

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-12
  const esPF = esPersonaFisicaRfc(company.rfc);

  const startYear = company.fechaInicioOperaciones
    ? Math.max(company.fechaInicioOperaciones.getFullYear(), curYear - MAX_ANIOS_ATRAS)
    : curYear - MAX_ANIOS_ATRAS;
  // Mes de arranque dentro del año de inicio (para no pedir meses previos).
  const startMonth =
    company.fechaInicioOperaciones && company.fechaInicioOperaciones.getFullYear() === curYear
      ? company.fechaInicioOperaciones.getMonth() + 1
      : 1;

  const decls = await prisma.taxDeclaration.findMany({
    where: { companyId },
    select: { tipo: true, periodo: true },
  });
  const have = new Set(decls.map((d) => `${d.tipo}:${d.periodo}`));

  const out: AcuseFaltante[] = [];

  // 1. Años cerrados → ANUAL (cubre ISR mensual del año).
  if (tieneAnual) {
    for (let y = startYear; y < curYear; y++) {
      // La anual del ejercicio inmediato anterior no "falta" antes de su fecha
      // límite (ene–mar PM / ene–abr PF): está por presentarse.
      if (!anualVencida(y, esPF, now)) continue;
      if (!have.has(`DECLARACION_ANUAL:${y}`)) {
        out.push({
          companyId,
          tipo: "DECLARACION_ANUAL",
          periodo: String(y),
          etiqueta: `Declaración anual ${y}`,
          motivo: "Coeficiente de utilidad y saldo de ISR — cubre los mensuales de ISR de ese año.",
          // Sólo la anual del ejercicio inmediato anterior define el coeficiente
          // del año en curso; las más viejas son históricas (no críticas).
          critico: y === curYear - 1,
        });
      }
    }
  }

  // 2. IVA del cierre del año anterior (no hay anual de IVA → arrastre de saldo).
  // Diciembre previo vence el 17 de enero: en la primera quincena de enero
  // todavía no falta.
  const dicPrevioVencido = mensualVencido(curYear - 1, 12, now);
  if (tieneIVA && dicPrevioVencido) {
    const prev = curYear - 1;
    if (prev >= startYear && !have.has(`IVA_MENSUAL:${prev}-12`)) {
      out.push({
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: `${prev}-12`,
        etiqueta: `IVA diciembre ${prev}`,
        motivo: "El IVA no tiene anual — necesitamos el último mes para arrastrar el saldo a favor.",
        critico: true,
      });
    }
  }
  // 2b. Ídem IEPS: definitivo mensual sin anual — diciembre previo trae el
  // saldo a favor arrastrable (sólo compensable contra IEPS, Art. 5o LIEPS).
  if (tieneIEPS && dicPrevioVencido) {
    const prev = curYear - 1;
    if (prev >= startYear && !have.has(`IEPS_MENSUAL:${prev}-12`)) {
      out.push({
        companyId,
        tipo: "IEPS_MENSUAL",
        periodo: `${prev}-12`,
        etiqueta: `IEPS diciembre ${prev}`,
        motivo: "El IEPS no tiene anual — el último mes trae el saldo a favor arrastrable.",
        critico: true,
      });
    }
  }

  // 3. Año en curso → mensuales transcurridos Y YA VENCIDOS. El mes anterior
  //    sólo cuenta como faltante después del 17 del mes en curso (en hábil):
  //    antes está pendiente de presentar, no perdido.
  const fromMonth = startYear === curYear ? startMonth : 1;
  for (let m = fromMonth; m < curMonth; m++) {
    if (!mensualVencido(curYear, m, now)) continue;
    const per = `${curYear}-${String(m).padStart(2, "0")}`;
    if (tieneISR && !have.has(`ISR_PROVISIONAL:${per}`)) {
      out.push({
        companyId,
        tipo: "ISR_PROVISIONAL",
        periodo: per,
        etiqueta: `ISR provisional ${MESES[m - 1]} ${curYear}`,
        motivo: "Pago provisional del año en curso (acreditable en la anual).",
        critico: true,
      });
    }
    if (tieneIVA && !have.has(`IVA_MENSUAL:${per}`)) {
      out.push({
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: per,
        etiqueta: `IVA ${MESES[m - 1]} ${curYear}`,
        motivo: "IVA del año en curso (saldo a favor / a cargo).",
        critico: true,
      });
    }
    if (tieneIEPS && !have.has(`IEPS_MENSUAL:${per}`)) {
      out.push({
        companyId,
        tipo: "IEPS_MENSUAL",
        periodo: per,
        etiqueta: `IEPS ${MESES[m - 1]} ${curYear}`,
        motivo: "IEPS definitivo del año en curso (saldo a favor / a cargo).",
        critico: true,
      });
    }
  }

  return out;
}
