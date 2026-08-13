// ─────────────────────────────────────────────────────────────────────────────
// Ajuste anual por inflación pendiente de incorporar a la anual (Arts. 44-46).
//
// El campo existía como CAPTURA MANUAL con default 0, así que en la práctica
// toda anual de PM salía con ajuste cero. Ahora la cifra se deriva del ledger,
// pero eso no sirve de nada si nadie abre el panel: este hallazgo la empuja.
//
// Conservador a propósito. NO afirma que la anual esté mal —no guardamos el
// desglose de lo que se capturó, así que no podemos probarlo—; afirma lo que sí
// consta: que el ejercicio tiene un ajuste determinable y material. Y sólo lo
// levanta cuando la cifra es confiable: PM, ejercicio cerrado, meses posteados
// e INPC disponible. Sin eso, callar es mejor que un falso positivo.
// ─────────────────────────────────────────────────────────────────────────────

import { balanceGeneralDesdeBalanza } from "@/lib/contabilidad/libro";
import { balanza } from "@/lib/contabilidad/posting";
import { cargarAjusteInflacion } from "@/lib/fiscal/ajuste-inflacion-ledger";
import { inferTipoPersona } from "@/lib/fiscal/rules/sector";
import { prisma } from "@/lib/prisma";
import type { Hallazgo } from "./types";

/** Debajo de esto el ajuste no mueve la aguja y sólo sería ruido. */
export const UMBRAL_MONTO = 5_000;

export interface AjusteInflacionPendiente {
  companyId: string;
  ejercicio: number;
  tipoPersona: "PM" | "PF";
  /** false cuando falta INPC: no hay cifra que reclamar. */
  calculable: boolean;
  acumulable: number;
  deducible: number;
  /** Meses del ejercicio sin postear: con huecos el promedio no es confiable. */
  mesesSinPostear: number[];
  /** Estado de la anual guardada, si existe. */
  statusDeclaracion: string | null;
  /**
   * |descuadre| ÷ activo total al cierre. null si no se pudo evaluar.
   *
   * El ajuste sale de los saldos del balance: si la ecuación contable no
   * cuadra, esos saldos no describen a la empresa y la cifra no significa
   * nada. Salió de mirar producción — una empresa con el libro descuadrado
   * producía un ajuste de ocho cifras a partir de cuatro cuentas.
   */
  descuadreRelativo: number | null;
}

/** Descuadre máximo tolerado para creerle a los saldos del balance. */
export const TOLERANCIA_DESCUADRE = 0.01;

/**
 * Carga el ajuste del ÚLTIMO ejercicio cerrado (el que ya toca declarar).
 *
 * Sale temprano para las PF —el ajuste es del Título II— antes de tocar el
 * ledger: el auditor corre por empresa y la mitad del padrón son PF.
 */
export async function cargarAjusteInflacionPendiente(
  companyId: string,
  hoy: Date
): Promise<AjusteInflacionPendiente> {
  const ejercicio = hoy.getFullYear() - 1;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  const tipoPersona = company ? inferTipoPersona(company.rfc) : "PF";

  const vacio: AjusteInflacionPendiente = {
    companyId,
    ejercicio,
    tipoPersona,
    calculable: false,
    acumulable: 0,
    deducible: 0,
    mesesSinPostear: [],
    statusDeclaracion: null,
    descuadreRelativo: null,
  };
  if (tipoPersona !== "PM") return vacio;

  const [{ resultado, mesesSinPostear }, declaracion, filasDic] = await Promise.all([
    cargarAjusteInflacion(companyId, ejercicio),
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo: String(ejercicio) },
      select: { status: true },
    }),
    balanza(companyId, ejercicio, 12),
  ]);

  // Ecuación contable al cierre: la prueba de que los saldos que alimentan el
  // promedio anual describen a una empresa real.
  const bg = balanceGeneralDesdeBalanza(filasDic);
  const base = Math.abs(bg.totalActivo);
  const descuadreRelativo = base > 0 ? Math.abs(bg.descuadre) / base : null;

  return {
    ...vacio,
    calculable: resultado.calculable,
    acumulable: resultado.acumulable,
    deducible: resultado.deducible,
    mesesSinPostear,
    statusDeclaracion: declaracion?.status ?? null,
    descuadreRelativo,
  };
}

export function auditarAjusteInflacion(data: AjusteInflacionPendiente): Hallazgo[] {
  // El ajuste anual por inflación es del Título II: sólo personas morales.
  if (data.tipoPersona !== "PM") return [];
  if (!data.calculable) return [];
  // Con meses sin postear el saldo promedio anual del Art. 44 frac. I sale
  // incompleto; reclamar una cifra mal formada es peor que no reclamar nada.
  if (data.mesesSinPostear.length > 0) return [];
  // Si el balance no cuadra, sus saldos no describen a la empresa: el promedio
  // anual que sale de ahí no es una cifra fiscal, es ruido con dos decimales.
  // Callar es obligatorio — este hallazgo puede mandar a alguien a presentar
  // una complementaria.
  if (data.descuadreRelativo == null || data.descuadreRelativo > TOLERANCIA_DESCUADRE) return [];

  const acumulable = data.acumulable > 0;
  const monto = acumulable ? data.acumulable : data.deducible;
  if (monto < UMBRAL_MONTO) return [];

  const fmt = monto.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
  const presentada = data.statusDeclaracion === "FILED";

  const mensaje = acumulable
    ? `La anual ${data.ejercicio} tiene un ajuste anual por inflación ACUMULABLE de ${fmt} que suma a tus ingresos.`
    : `La anual ${data.ejercicio} tiene un ajuste anual por inflación DEDUCIBLE de ${fmt} que puedes restar de tu resultado fiscal.`;

  return [
    {
      checkClave: "anual.ajuste_inflacion_pendiente",
      // Si ya se presentó, revisar una cifra omitida obliga a complementaria:
      // pesa más que tenerlo pendiente de incorporar.
      severidad: presentada ? "error" : "warn",
      mensaje: presentada
        ? `${mensaje} La declaración ya está marcada como presentada: verifica que la haya incluido.`
        : mensaje,
      referencias: [data.companyId],
      dedupeRef: `anual.ajuste_inflacion_pendiente:${data.ejercicio}`,
      fundamento: { ley: "LISR", articulo: "44" },
      sugerencia: presentada
        ? `Coteja el acuse de la anual ${data.ejercicio} contra el panel de ajuste por inflación; si no lo incluyó, presenta complementaria.`
        : `Abre la Declaración Anual ${data.ejercicio} y aplica la cifra del panel de ajuste por inflación antes de calcular el ISR.`,
    },
  ];
}
