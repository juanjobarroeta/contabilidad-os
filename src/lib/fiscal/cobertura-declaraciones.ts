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
//
// Es un "nag" no destructivo: en el peor caso pide un acuse de más; nunca borra.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
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
  if (tieneIVA) {
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
  if (tieneIEPS) {
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

  // 3. Año en curso → mensuales transcurridos (hasta el mes anterior).
  const fromMonth = startYear === curYear ? startMonth : 1;
  for (let m = fromMonth; m < curMonth; m++) {
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
