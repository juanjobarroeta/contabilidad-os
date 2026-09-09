// ─────────────────────────────────────────────────────────────────────────────
// TRASPASOS ENTRE CUENTAS PROPIAS — el espejo está en nuestra propia base.
//
// El banco rara vez dice a dónde fue el dinero: «COMPRA ORDEN DE PAGO SPEI» o
// «RETIRO DEP. ELECTRONICO» no nombran cuenta destino, así que no hay CLABE que
// extraer y la detección por contraparte no dispara. Pero el otro lado del
// traspaso YA ESTÁ IMPORTADO: si una cuenta de la empresa muestra −$230,000 el
// 14-ago y otra cuenta de la MISMA empresa muestra +$230,000 ese día, ese par
// es el traspaso. No hace falta que el banco lo diga; nos lo dice la aritmética.
//
// Medido en un hospital real: 10 pares, $1,251,000, que cubren 19 movimientos
// pendientes — casi todos «COMPRA ORDEN DE PAGO SPEI» de BBVA contra «SPEI
// RECIBIDO BANORTE».
//
// REGLA DE EMPAREJAMIENTO: unicidad MUTUA. Sólo se empareja A con B si A es el
// único espejo posible de B y B el único de A. Con tres movimientos de
// $10,000 el mismo día no hay forma de saber cuál va con cuál, y adivinar
// mezclaría traspasos con cobros reales.
//
// El posteo ya sabe qué hacer: ambos quedan IGNORED + INTERNAL_TRANSFER y
// `planearTraspasos` los manda a lavado (contraparte no resoluble por CLABE),
// donde el cargo de uno y el abono del otro se netean a cero. Visible y
// warneado, nunca silencioso.
// ─────────────────────────────────────────────────────────────────────────────

/** Días entre las dos patas: un traspaso puede caer en el corte del día. */
export const DIAS_ESPEJO = 3;
const CENTAVO = 0.01;

export interface MovimientoEspejo {
  id: string;
  fecha: Date;
  monto: number;
  bankAccountId: string;
  /** Sólo se emparejan pendientes; lo que un humano ya resolvió no se toca. */
  status: string;
}

export interface ParTraspaso {
  salidaId: string;
  entradaId: string;
  monto: number;
}

const esEspejo = (a: MovimientoEspejo, b: MovimientoEspejo): boolean =>
  a.id !== b.id &&
  a.bankAccountId !== b.bankAccountId &&
  Math.abs(a.monto + b.monto) < CENTAVO &&
  Math.abs(a.fecha.getTime() - b.fecha.getTime()) <= DIAS_ESPEJO * 86_400_000;

/**
 * Empareja traspasos entre cuentas propias por espejo. PURA.
 *
 * `pendientes` son los que se pueden etiquetar; `universo` incluye TODOS los
 * movimientos de la empresa, porque la otra pata puede estar ya conciliada o
 * ignorada y aun así identifica el traspaso.
 *
 * Devuelve sólo los pares con unicidad mutua. Un movimiento con dos espejos
 * posibles no se empareja: entre dos candidatos idénticos no hay evidencia
 * para elegir, y equivocarse marca como traspaso interno un cobro real.
 */
export function emparejarEspejos(
  pendientes: MovimientoEspejo[],
  universo: MovimientoEspejo[],
): ParTraspaso[] {
  const pares: ParTraspaso[] = [];
  const usados = new Set<string>();

  for (const tx of pendientes) {
    if (usados.has(tx.id)) continue;
    const candidatos = universo.filter((o) => !usados.has(o.id) && esEspejo(tx, o));
    if (candidatos.length !== 1) continue;

    // Unicidad MUTUA: el candidato tampoco puede tener otro espejo.
    const otro = candidatos[0];
    const inversos = universo.filter((o) => !usados.has(o.id) && o.id !== tx.id && esEspejo(otro, o));
    if (inversos.length !== 0) continue;

    usados.add(tx.id);
    usados.add(otro.id);
    const salida = tx.monto < 0 ? tx : otro;
    const entrada = tx.monto < 0 ? otro : tx;
    pares.push({ salidaId: salida.id, entradaId: entrada.id, monto: Math.abs(salida.monto) });
  }
  return pares;
}
