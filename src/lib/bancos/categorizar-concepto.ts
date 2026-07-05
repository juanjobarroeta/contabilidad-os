// ─────────────────────────────────────────────────────────────────────────────
// Categorizador de conceptos bancarios SIN CFDI (motor de reglas puro)
//
// Para los movimientos bancarios que NO empatan con un CFDI (comisiones, pago de
// impuestos, dispersión de nómina, traspasos, intereses, renta, etc.) este motor
// lee la `descripcion` (concepto) y el signo del monto y SUGIERE una cuenta del
// catálogo SAT (código agrupador) más una etiqueta de partida doble.
//
// El resultado es una SUGERENCIA de "un toque": el usuario la aprueba y recién
// entonces se escribe el asiento (fuente BANCO). El motor nunca postea por sí
// mismo.
//
// `sugerirCategoriaConcepto` es una función PURA, determinista e insensible a
// mayúsculas/acentos. Si no reconoce el concepto devuelve `null` (no adivina) y
// el movimiento queda sin clasificar — un fallback LLM opcional puede intentarlo.
//
// Las cuentas se expresan con los códigos de `COE_CODES` (catálogo SAT starter).
// La `familia` reutiliza las MISMAS etiquetas que el motor de cierre (postMonth)
// lee desde `notes` (TAX_PAYMENT, PAYROLL_NO_CFDI, …), para que la sugerencia y
// el cierre mensual hablen el mismo idioma.
// ─────────────────────────────────────────────────────────────────────────────

import { COE_CODES } from "@/lib/contabilidad/catalog";

/** Signo del movimiento: ingreso de dinero (crédito) o salida (débito). */
export type SignoMovimiento = "CREDITO" | "DEBITO";

/**
 * Familias de concepto que el motor de cierre (postMonth) ya entiende vía la
 * etiqueta en `BankTransaction.notes`. La sugerencia las reutiliza tal cual.
 */
export type FamiliaConcepto =
  | "COMISION" // comisiones / gastos bancarios → 601.84
  | "TAX_PAYMENT" // impuestos y derechos pagados → 601.20
  | "PAYROLL_NO_CFDI" // dispersión de nómina sin CFDI → 601.01
  | "INTERNAL_TRANSFER" // traspaso entre cuentas propias → 102.01 (lavado)
  | "FINANCIAL_INCOME" // intereses / rendimientos ganados → 402.01
  | "RENT" // renta / arrendamiento pagado → 601.03
  | "NON_DEDUCTIBLE"; // gasto no deducible → 603.01

export interface SugerenciaCategoria {
  /** Familia interna (coincide con la etiqueta de notes que lee postMonth). */
  familia: FamiliaConcepto;
  /** Código de cuenta SAT sugerido (la contracuenta de Bancos). */
  cuentaSugerida: string;
  /** Etiqueta legible en español formal para mostrar en la UI. */
  etiqueta: string;
  /** Confianza de la regla: alta (palabra inequívoca) o media. */
  confianza: "alta" | "media";
}

/**
 * Metadatos por familia: la contracuenta SAT y la etiqueta legible. Se usan para
 * construir una `SugerenciaCategoria` a partir de una regla PERSISTIDA del
 * usuario (que sólo guarda el patrón + la familia elegida). El código de cuenta
 * espeja el que usa `construirAsiento`/postMonth para cada familia.
 */
export const FAMILIA_META: Record<FamiliaConcepto, { cuenta: string; etiqueta: string }> = {
  COMISION: { cuenta: COE_CODES.COMISIONES_BANCARIAS, etiqueta: "Comisiones bancarias" },
  TAX_PAYMENT: { cuenta: COE_CODES.IMPUESTOS_DERECHOS, etiqueta: "Impuestos y derechos" },
  PAYROLL_NO_CFDI: { cuenta: COE_CODES.SUELDOS_SALARIOS, etiqueta: "Nómina (sueldos y salarios)" },
  INTERNAL_TRANSFER: { cuenta: COE_CODES.BANCOS, etiqueta: "Traspaso entre cuentas propias" },
  FINANCIAL_INCOME: { cuenta: COE_CODES.OTROS_INGRESOS, etiqueta: "Productos financieros (intereses ganados)" },
  RENT: { cuenta: COE_CODES.RENTAS, etiqueta: "Rentas" },
  NON_DEDUCTIBLE: { cuenta: COE_CODES.GASTOS_NO_DEDUCIBLES, etiqueta: "Gasto no deducible" },
};

/**
 * Regla de categorización PERSISTIDA de la empresa (subconjunto de las columnas
 * del modelo Prisma `CategorizationRule` que el matcher necesita). Se pasa como
 * argumento — el matcher NO consulta la base de datos, sigue siendo puro.
 */
export interface CompanyRule {
  pattern: string;
  matchType?: string; // "CONTAINS" (default) | "EXACT" | "STARTS_WITH"
  familia: FamiliaConcepto;
  signo?: SignoMovimiento | null;
}

/** True si el concepto (normalizado) empata con el patrón de la regla. */
function reglaEmpata(normConcepto: string, regla: CompanyRule): boolean {
  const patron = normalizar(regla.pattern);
  if (!patron) return false;
  switch (regla.matchType) {
    case "EXACT":
      return normConcepto === patron;
    case "STARTS_WITH":
      return normConcepto.startsWith(patron);
    default: // CONTAINS
      return normConcepto.includes(patron);
  }
}

/** Quita acentos/diacríticos y normaliza a mayúsculas para comparar. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacríticos
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Una regla = patrones de palabra (ya normalizados, sin acentos) que disparan
// una familia. `soloSigno` restringe la regla a un signo del movimiento (p.ej.
// intereses ganados sólo aplican a un crédito). El orden importa: las reglas más
// específicas/seguras van primero.
interface Regla {
  patrones: string[];
  familia: FamiliaConcepto;
  cuenta: string;
  etiqueta: string;
  confianza: "alta" | "media";
  soloSigno?: SignoMovimiento;
}

const REGLAS: Regla[] = [
  // ── Comisiones / gastos bancarios ──────────────────────────────────────────
  {
    patrones: [
      "COMISION",
      "CARGO POR SERVICIO",
      "MANEJO DE CUENTA",
      "ANUALIDAD",
      "MEMBRESIA",
    ],
    familia: "COMISION",
    cuenta: COE_CODES.COMISIONES_BANCARIAS,
    etiqueta: "Comisiones bancarias",
    confianza: "alta",
  },
  // ── Intereses / rendimientos GANADOS (sólo entradas) ───────────────────────
  {
    patrones: ["RENDIMIENTO", "INTERES", "PRODUCTO FINANCIERO"],
    familia: "FINANCIAL_INCOME",
    cuenta: COE_CODES.OTROS_INGRESOS,
    etiqueta: "Productos financieros (intereses ganados)",
    confianza: "alta",
    soloSigno: "CREDITO",
  },
  // ── Impuestos / contribuciones / derechos ──────────────────────────────────
  {
    patrones: [
      "SAT",
      "IMPUESTO",
      "ISR",
      "IVA",
      "DPA",
      "DERECHOS PRODUCTOS Y APROVECHAMIENTOS",
      "CONTRIBUCION",
      "TENENCIA",
      "PREDIAL",
      "DECLARACION",
      "SHCP",
      "TESORERIA",
    ],
    familia: "TAX_PAYMENT",
    cuenta: COE_CODES.IMPUESTOS_DERECHOS,
    etiqueta: "Impuestos y derechos",
    confianza: "alta",
  },
  // ── Nómina / dispersión ─────────────────────────────────────────────────────
  {
    patrones: [
      "NOMINA",
      "DISPERSION",
      "RAYA",
      "SUELDOS",
      "SALARIOS",
      "PAGO A EMPLEADOS",
    ],
    familia: "PAYROLL_NO_CFDI",
    cuenta: COE_CODES.SUELDOS_SALARIOS,
    etiqueta: "Nómina (sueldos y salarios)",
    confianza: "alta",
  },
  // ── Renta / arrendamiento ───────────────────────────────────────────────────
  {
    patrones: ["RENTA", "ARRENDAMIENTO"],
    familia: "RENT",
    cuenta: COE_CODES.RENTAS,
    etiqueta: "Rentas",
    confianza: "alta",
  },
  // ── Traspasos / transferencias entre cuentas propias ───────────────────────
  // Confianza media: un SPEI/TRANSFERENCIA puede ser un pago real con CFDI; sólo
  // lo sugerimos cuando no empató con ningún CFDI y el concepto huele a traspaso.
  {
    patrones: [
      "TRASPASO",
      "TRANSFERENCIA ENTRE CUENTAS",
      "TRANSFERENCIA PROPIA",
      "CUENTA PROPIA",
      "SPEI",
      "TRANSFERENCIA",
    ],
    familia: "INTERNAL_TRANSFER",
    cuenta: COE_CODES.BANCOS,
    etiqueta: "Traspaso entre cuentas propias",
    confianza: "media",
  },
];

/**
 * Sugiere una categoría contable para un movimiento bancario SIN CFDI a partir
 * de su concepto y signo. Función pura y determinista. Devuelve `null` cuando
 * ninguna regla aplica (mejor dejar sin clasificar que adivinar).
 *
 * Las reglas PERSISTIDAS de la empresa (`companyRules`) se evalúan ANTES que las
 * reglas hardcodeadas: una regla que el usuario confirmó siempre gana. Sólo se
 * consideran las reglas activas cuyo signo (si lo fijan) coincide. El matcher no
 * consulta la base de datos — las reglas se pasan ya cargadas, para mantenerlo
 * puro y testeable.
 *
 * @param concepto      Descripción del movimiento (BankTransaction.descripcion).
 * @param signo         "CREDITO" (entra dinero) | "DEBITO" (sale dinero).
 * @param companyRules  Reglas persistidas de la empresa (opcional). Ganan sobre REGLAS.
 */
export function sugerirCategoriaConcepto(
  concepto: string,
  signo: SignoMovimiento,
  companyRules?: CompanyRule[],
): SugerenciaCategoria | null {
  if (!concepto || !concepto.trim()) return null;
  const norm = normalizar(concepto);

  // 1) Reglas del usuario primero (ganan sobre el motor hardcodeado).
  if (companyRules && companyRules.length > 0) {
    for (const regla of companyRules) {
      if (regla.signo && regla.signo !== signo) continue;
      if (reglaEmpata(norm, regla)) {
        const meta = FAMILIA_META[regla.familia];
        if (!meta) continue; // familia desconocida → ignorar la regla, no adivinar
        return {
          familia: regla.familia,
          cuentaSugerida: meta.cuenta,
          etiqueta: meta.etiqueta,
          confianza: "alta", // el usuario la confirmó
        };
      }
    }
  }

  // 2) Motor de reglas hardcodeado.
  for (const regla of REGLAS) {
    if (regla.soloSigno && regla.soloSigno !== signo) continue;
    const match = regla.patrones.some((p) => norm.includes(normalizar(p)));
    if (match) {
      return {
        familia: regla.familia,
        cuentaSugerida: regla.cuenta,
        etiqueta: regla.etiqueta,
        confianza: regla.confianza,
      };
    }
  }

  return null;
}

/** Conveniencia: deriva el signo a partir del monto firmado (>0 = crédito). */
export function signoDeMonto(monto: number): SignoMovimiento {
  return monto > 0 ? "CREDITO" : "DEBITO";
}

/**
 * Devuelve la PRIMERA regla persistida de la empresa que empata con el concepto
 * y el signo, o `null`. A diferencia de `sugerirCategoriaConcepto`, entrega la
 * regla misma (no una `SugerenciaCategoria`), para que quien la aplica —el
 * importador— pueda, por ejemplo, incrementar su `hitCount`. Puro: no consulta
 * la base de datos. El genérico preserva campos extra de la regla (p. ej. `id`).
 */
export function primeraReglaQueEmpata<T extends CompanyRule>(
  concepto: string,
  signo: SignoMovimiento,
  rules: T[],
): T | null {
  if (!concepto || !concepto.trim() || rules.length === 0) return null;
  const norm = normalizar(concepto);
  for (const regla of rules) {
    if (regla.signo && regla.signo !== signo) continue;
    if (!FAMILIA_META[regla.familia]) continue;
    if (reglaEmpata(norm, regla)) return regla;
  }
  return null;
}
