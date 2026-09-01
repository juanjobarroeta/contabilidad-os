// ─────────────────────────────────────────────────────────────────────────────
// ¿Qué ES este movimiento, si no es una factura?
//
// La mesa de conciliación sólo ofrecía CFDIs (y declaraciones para los cargos).
// Pero el producto YA sabe clasificar lo demás — préstamos, aportaciones,
// traspasos, nómina — vía `PATCH ignore + notes`, y el cierre (postMonth) postea
// cada tag con su asiento correcto. Este módulo pone ese vocabulario al alcance
// de la mesa y agrega la capa que faltaba: INFERIR la categoría con lo que ya
// extrajimos del propio estado de cuenta.
//
// Orden de certeza (el caller lo respeta):
//   1. IDENTIDAD (este módulo, determinista): el RFC del movimiento es el de la
//      PROPIA empresa, o la CLABE es de otra cuenta propia, o existe el
//      movimiento espejo en otra cuenta (mismo monto opuesto, ±1 día), o el RFC
//      es de un empleado. Datos duros, cero adivinanza.
//   2. Reglas (motor puro `sugerirCategoriaConcepto` + reglas de la empresa).
//   3. LLM acotado (`sugerirCategoriaConceptoLLM`) — sólo texto, confianza
//      media, y únicamente cuando 1 y 2 no dieron nada.
//
// Regla de la casa: ante la duda, null. Una clasificación equivocada escribe un
// asiento equivocado.
//
// PURO. Los datos (RFC de la empresa, CLABEs propias, empleados, espejo) los
// junta el caller — este módulo sólo decide.
// ─────────────────────────────────────────────────────────────────────────────

import type { FamiliaConcepto } from "./categorizar-concepto";
import { mismoNombre } from "./auto-conciliar";

/** Tags de `BankTransaction.notes` que postMonth postea con asiento propio. */
export type TagSinFactura =
  | "PENDING_MONTHLY_CFDI"
  | "TAX_PAYMENT"
  | "PAYROLL_NO_CFDI"
  | "LOAN_RECEIVED"
  | "LOAN_GIVEN"
  | "CAPITAL_CONTRIBUTION"
  | "NON_DEDUCTIBLE"
  | "INTERNAL_TRANSFER";

/**
 * Las categorías que la mesa ofrece de un toque — las MISMAS del tab
 * Movimientos (GestionBancos), mismo orden y mismas etiquetas: un usuario que
 * aprendió una lista no debe encontrarse otra. `null` = ignorar simple (no
 * genera póliza).
 */
export const CATEGORIAS_MESA: { tag: TagSinFactura | null; label: string }[] = [
  { tag: "TAX_PAYMENT", label: "Pago de impuestos" },
  { tag: "PAYROLL_NO_CFDI", label: "Nómina sin CFDI" },
  { tag: "LOAN_RECEIVED", label: "Préstamo recibido" },
  { tag: "LOAN_GIVEN", label: "Préstamo otorgado" },
  { tag: "CAPITAL_CONTRIBUTION", label: "Aportación de capital" },
  { tag: "NON_DEDUCTIBLE", label: "No deducible" },
  { tag: "INTERNAL_TRANSFER", label: "Transferencia entre cuentas" },
  { tag: null, label: "Ignorar" },
];

/**
 * Familia del motor de reglas/LLM → tag que postMonth entiende.
 *
 * RENT y FINANCIAL_INCOME devuelven null A PROPÓSITO: postMonth no regenera
 * su asiento desde `notes` (sólo `aprobarSugerencia` los escribe, y ese asiento
 * no sobrevive un re-posteo del mes). Ofrecerlos de un toque en la mesa dejaría
 * pólizas que se esfuman al reprocesar — mejor no sugerir lo que no se sostiene.
 */
export function familiaATag(familia: FamiliaConcepto): TagSinFactura | null {
  switch (familia) {
    case "COMISION":
      return "PENDING_MONTHLY_CFDI";
    case "TAX_PAYMENT":
    case "PAYROLL_NO_CFDI":
    case "INTERNAL_TRANSFER":
    case "NON_DEDUCTIBLE":
    case "LOAN_RECEIVED":
    case "LOAN_GIVEN":
      return familia;
    case "RENT":
    case "FINANCIAL_INCOME":
      return null;
  }
}

export interface SugerenciaMovimiento {
  tag: TagSinFactura;
  /** Nombre legible de la categoría («Transferencia entre cuentas»). */
  etiqueta: string;
  /** La EVIDENCIA, para que el usuario decida con ella, no con fe. */
  porQue: string;
  confianza: "alta" | "media";
  fuente: "identidad" | "reglas" | "llm";
}

export interface ContextoIdentidad {
  /** RFC de la propia empresa. */
  rfcEmpresa: string | null;
  /** CLABE → etiqueta («BANORTE · Operativa») de las cuentas propias. */
  clabesPropias: Map<string, string>;
  /** RFC → nombre de los empleados de la empresa. */
  empleadosPorRfc: Map<string, string>;
  /**
   * Movimiento espejo en OTRA cuenta propia: mismo monto opuesto, ±3 días.
   * La ventana es estrecha A PROPÓSITO (decidido con Juan): ±3 cubre el fin de
   * semana (transferencia del viernes que asienta el lunes), pero un mes
   * falsearía — los montos idénticos se repiten (rentas, igualas) y este
   * veredicto etiqueta el movimiento como traspaso propio, no como sugerencia
   * vaga. La fecha viaja para que el usuario juzgue con la evidencia.
   */
  espejo: { etiquetaCuenta: string; fecha: string } | null;
}

const ETIQUETA: Record<TagSinFactura, string> = Object.fromEntries(
  CATEGORIAS_MESA.filter((c) => c.tag).map((c) => [c.tag, c.label])
) as Record<TagSinFactura, string>;

/**
 * Inferencia determinista por identidad. Devuelve la categoría sólo cuando un
 * dato duro la sostiene; si no, null — las capas de reglas/LLM siguen después.
 */
export function inferirPorIdentidad(
  mov: {
    monto: number;
    contraparteRfc?: string | null;
    contraparteClabe?: string | null;
    contraparteNombre?: string | null;
  },
  ctx: ContextoIdentidad
): SugerenciaMovimiento | null {
  const rfc = mov.contraparteRfc?.trim().toUpperCase() || null;
  const clabe = mov.contraparteClabe?.trim() || null;

  if (rfc && ctx.rfcEmpresa && rfc === ctx.rfcEmpresa.trim().toUpperCase()) {
    return {
      tag: "INTERNAL_TRANSFER",
      etiqueta: ETIQUETA.INTERNAL_TRANSFER,
      porQue: "el RFC del movimiento es el de tu propia empresa",
      confianza: "alta",
      fuente: "identidad",
    };
  }

  if (clabe && ctx.clabesPropias.has(clabe)) {
    return {
      tag: "INTERNAL_TRANSFER",
      etiqueta: ETIQUETA.INTERNAL_TRANSFER,
      porQue: `la CLABE es de tu cuenta ${ctx.clabesPropias.get(clabe)}`,
      confianza: "alta",
      fuente: "identidad",
    };
  }

  if (ctx.espejo && mov.monto !== 0) {
    return {
      tag: "INTERNAL_TRANSFER",
      etiqueta: ETIQUETA.INTERNAL_TRANSFER,
      porQue: `${ctx.espejo.etiquetaCuenta} tiene el movimiento espejo (mismo monto opuesto, ${ctx.espejo.fecha})`,
      confianza: "alta",
      fuente: "identidad",
    };
  }

  // Sólo egresos: un DEPÓSITO de un empleado no es nómina (puede ser un
  // reembolso o cualquier otra cosa) — ahí no se afirma nada.
  if (rfc && mov.monto < 0 && ctx.empleadosPorRfc.has(rfc)) {
    return {
      tag: "PAYROLL_NO_CFDI",
      etiqueta: ETIQUETA.PAYROLL_NO_CFDI,
      porQue: `el RFC es de tu empleado(a) ${ctx.empleadosPorRfc.get(rfc)}`,
      confianza: "media",
      fuente: "identidad",
    };
  }

  // El banco a veces sólo da el NOMBRE (sin RFC — visto en BanBajío: pago a
  // una empleada sin RFC extraíble). El nombre completo también identifica,
  // con las mismas dos cautelas del RFC: sólo egresos, y sólo si empata con
  // UNA persona del padrón (dos homónimos = silencio; mejor callar que
  // adivinar).
  if (!rfc && mov.contraparteNombre && mov.monto < 0) {
    const empatan = [...ctx.empleadosPorRfc.values()].filter((n) =>
      mismoNombre(mov.contraparteNombre, n)
    );
    if (empatan.length === 1) {
      return {
        tag: "PAYROLL_NO_CFDI",
        etiqueta: ETIQUETA.PAYROLL_NO_CFDI,
        porQue: `el nombre coincide con tu empleado(a) ${empatan[0]}`,
        confianza: "media",
        fuente: "identidad",
      };
    }
  }

  return null;
}

/**
 * ¿"Traspaso entre cuentas propias" contradice la identidad del movimiento?
 *
 * Si el banco extrajo el RFC de la contraparte y NO es el de la empresa, el
 * dinero viene de (o va a) un tercero con nombre y apellido — sugerirle
 * "cuentas propias" a eso es afirmar algo que la evidencia ya desmintió. Sólo
 * aplica a sugerencias por texto (reglas/LLM): las de fuente "identidad" ya
 * traen evidencia propia (CLABE de la casa o movimiento espejo) y un RFC de
 * tercero en el concepto no las invalida (p. ej. un espejo real).
 */
export function esTraspasoContradictorio(
  sugerencia: Pick<SugerenciaMovimiento, "tag" | "fuente">,
  contraparteRfc: string | null | undefined,
  rfcEmpresa: string | null | undefined,
): boolean {
  if (sugerencia.tag !== "INTERNAL_TRANSFER" || sugerencia.fuente === "identidad") return false;
  const rfc = contraparteRfc?.trim().toUpperCase();
  if (!rfc) return false;
  return rfc !== (rfcEmpresa ?? "").trim().toUpperCase();
}
