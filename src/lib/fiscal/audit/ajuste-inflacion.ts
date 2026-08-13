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
}

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
  };
  if (tipoPersona !== "PM") return vacio;

  const [{ resultado, mesesSinPostear }, declaracion] = await Promise.all([
    cargarAjusteInflacion(companyId, ejercicio),
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo: String(ejercicio) },
      select: { status: true },
    }),
  ]);

  return {
    ...vacio,
    calculable: resultado.calculable,
    acumulable: resultado.acumulable,
    deducible: resultado.deducible,
    mesesSinPostear,
    statusDeclaracion: declaracion?.status ?? null,
  };
}

export function auditarAjusteInflacion(data: AjusteInflacionPendiente): Hallazgo[] {
  // El ajuste anual por inflación es del Título II: sólo personas morales.
  if (data.tipoPersona !== "PM") return [];
  if (!data.calculable) return [];
  // Con meses sin postear el saldo promedio anual del Art. 44 frac. I sale
  // incompleto; reclamar una cifra mal formada es peor que no reclamar nada.
  if (data.mesesSinPostear.length > 0) return [];

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
