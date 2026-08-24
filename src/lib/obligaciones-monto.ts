// ─────────────────────────────────────────────────────────────────────────────
// CUÁNTO se debe de una obligación, y si esa cifra es un HECHO o una CUENTA
// NUESTRA.
//
// POR QUÉ EXISTE. El tablero avisaba «Tienes 2 obligaciones vencidas —
// te decimos exactamente cuánto y cómo» y luego no decía cuánto: el tipo que
// alimenta esa lista no cargaba importe. No era descuido, era imposible.
//
// El dato ya estaba a la mano y se tiraba: el tablero YA consultaba la
// TaxDeclaration de ese período exacto para saber si estaba presentada, y se
// quedaba nada más con el booleano.
//
// LA DISTINCIÓN QUE IMPORTA. Una declaración PRESENTADA trae el importe que el
// SAT acusó: es un hecho. Una en borrador o calculada trae lo que ESTE motor
// dedujo de los CFDIs: es una estimación, y puede moverse cuando entren
// facturas rezagadas o se concilie el banco. Enseñar las dos con la misma
// tipografía sería afirmar como cierto algo que no lo es — y a un contador le
// basta cazar UNA cifra en la que no puede confiar para dejar de confiar en
// todas. Por eso `estimado` viaja con el monto y la UI está obligada a verlo.
//
// SIN FILA NO HAY MONTO. Si no existe declaración para el período, se devuelve
// null: no se inventa un cero. Cero pesos y "no lo hemos calculado" son cosas
// distintas, y la segunda no se disfraza de la primera.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que este motor necesita de una TaxDeclaration (facilita el test). */
export interface DeclaracionParaMonto {
  status: string;
  ivaPagar?: number | null;
  isrPagar?: number | null;
  retencionesIsr?: number | null;
  iepsPagar?: number | null;
  imssCuotas?: number | null;
}

export interface MontoObligacion {
  /** Pesos a pagar. `null` = no hay cifra; ver `motivo` para saber POR QUÉ. */
  monto: number | null;
  /**
   * Por qué no hay monto. La distinción no es cosmética: «informativa» dice
   * que NO HAY NADA QUE PAGAR (una DIOT se presenta, no se paga), mientras
   * que «sin_calcular» admite que el trabajo está pendiente de nuestro lado.
   * Enseñar «sin calcular» en una DIOT nos acusa de algo que no hicimos mal, y
   * le sugiere al contador que espere un número que nunca va a llegar.
   */
  motivo: "informativa" | "sin_calcular" | null;
  /**
   * `true` cuando el monto sale de NUESTRO cálculo (borrador/calculada) y no
   * del acuse del SAT. La UI debe marcarlo como aproximado.
   */
  estimado: boolean;
}

const INFORMATIVA: MontoObligacion = { monto: null, motivo: "informativa", estimado: false };
const SIN_CALCULAR: MontoObligacion = { monto: null, motivo: "sin_calcular", estimado: false };

/** Una declaración cuenta como hecho consumado sólo si ya se presentó o pagó. */
function esHecho(status: string): boolean {
  return status === "FILED" || status === "PAID";
}

/**
 * El importe de la obligación según su tipo.
 *
 * DIOT y CERO no llevan importe: son informativas. Devolver 0 para ellas
 * pintaría "$0.00 por pagar" donde lo correcto es no pintar nada.
 */
export function montoDeObligacion(
  tipo: string,
  decl: DeclaracionParaMonto | null | undefined
): MontoObligacion {
  if (!decl) return SIN_CALCULAR;

  const estimado = !esHecho(decl.status);
  const de = (v: number | null | undefined): MontoObligacion =>
    typeof v === "number" && Number.isFinite(v)
      ? { monto: v, motivo: null, estimado }
      : SIN_CALCULAR;

  switch (tipo) {
    case "IVA_MENSUAL":
      return de(decl.ivaPagar);
    case "ISR_PROVISIONAL":
    case "DECLARACION_ANUAL":
      return de(decl.isrPagar);
    case "RETENCIONES_ISR":
      return de(decl.retencionesIsr);
    case "IEPS_MENSUAL":
      return de(decl.iepsPagar);
    case "IMSS":
      return de(decl.imssCuotas);
    // Informativas: no hay nada que pagar, y eso NO es un cálculo pendiente.
    case "DIOT":
    case "CERO":
      return INFORMATIVA;
    default:
      return SIN_CALCULAR;
  }
}

/**
 * Suma de lo VENCIDO y no presentado — el número que encabeza el tablero.
 *
 * Se ignora lo que no tiene monto conocido en vez de contarlo como cero, y se
 * reporta cuántas quedaron fuera: un total que esconde tres obligaciones sin
 * cifra es peor que un total que dice "y otras 3 sin calcular".
 */
export function totalVencido(
  obligaciones: Array<{
    status: string; filed: boolean; monto: number | null;
    montoEstimado: boolean; montoMotivo?: "informativa" | "sin_calcular" | null;
  }>
): {
  total: number; conMonto: number; sinMonto: number;
  /** De las que no traen cifra, cuántas es porque NO se paga (DIOT, CERO). */
  informativas: number;
  algunoEstimado: boolean;
} {
  const vencidas = obligaciones.filter((o) => o.status === "OVERDUE" && !o.filed);
  let total = 0;
  let conMonto = 0;
  let sinMonto = 0;
  let informativas = 0;
  let algunoEstimado = false;
  for (const o of vencidas) {
    if (typeof o.monto === "number") {
      total += o.monto;
      conMonto++;
      if (o.montoEstimado) algunoEstimado = true;
    } else if (o.montoMotivo === "informativa") {
      informativas++;
    } else {
      sinMonto++;
    }
  }
  return { total, conMonto, sinMonto, informativas, algunoEstimado };
}

/**
 * Rellena el importe con el cálculo EN VIVO del período fiscal en juego.
 *
 * POR QUÉ HACE FALTA. `montoDeObligacion` lee la fila de TaxDeclaration, y para
 * un período que todavía no se captura esa fila no existe → «sin importe». Pero
 * el tablero YA calcula ese mismo período desde los CFDIs (`computeTaxPosition`)
 * y lo enseña en la tarjeta «¿Cuánto debo?». El resultado era un tablero que se
 * contradecía a sí mismo: la banda decía «4 obligaciones vencidas · sin importe»
 * y la tarjeta de abajo, del MISMO julio, decía $333.79 (visto en producción,
 * MERCEDES TRESPALACIOS). Enseñar «no lo sabemos» arriba de la cifra que sí
 * sabemos es peor que no enseñar nada.
 *
 * TRES REGLAS, EN ESTE ORDEN:
 *
 *   1. Una declaración PRESENTADA gana siempre. Es el importe que el SAT acusó;
 *      nuestro cálculo no lo pisa.
 *   2. Una INFORMATIVA sigue sin importe. La DIOT no se paga, y el cálculo del
 *      período no le aplica.
 *   3. Lo demás toma la cifra viva y va marcado `estimado`: sale de los CFDIs,
 *      no de un acuse, y puede moverse cuando entren facturas rezagadas.
 *
 * El CERO es un importe válido: un IVA de $0.00 es un hecho («no debes IVA»),
 * no un dato ausente. Por eso se distingue de `null`.
 */
export function conCalculoEnVivo(
  base: MontoObligacion,
  tipo: string,
  calculado: { iva: number | null; isr: number | null } | null
): MontoObligacion {
  // 1 · lo presentado manda; 2 · las informativas no llevan importe.
  if (base.monto !== null || base.motivo === "informativa") return base;
  if (!calculado) return base;

  const vivo =
    tipo === "IVA_MENSUAL" ? calculado.iva
    : tipo === "ISR_PROVISIONAL" ? calculado.isr
    : null;

  if (typeof vivo !== "number" || !Number.isFinite(vivo)) return base;
  return { monto: vivo, motivo: null, estimado: true };
}
