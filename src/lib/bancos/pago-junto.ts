// ─────────────────────────────────────────────────────────────────────────────
// PAGO JUNTO — un SPEI que salda varias facturas de la MISMA contraparte.
//
// El match normal empareja movimiento ↔ UNA factura por monto≈total; cuando un
// cliente paga 3 facturas en una sola transferencia, ninguna factura sola
// "cabe" y el humano termina sumando a mano. Este sugeridor busca el
// subconjunto de saldos abiertos de una contraparte que sume EXACTO (al
// centavo) el monto del movimiento.
//
// Reglas de la casa:
//  - Identidad primero: sólo se combinan facturas de la MISMA contraparte
//    (RFC efectivo). Un subset-sum sobre toda la cartera fabrica coincidencias.
//  - Ante la duda, no se emite: si más de un subconjunto (de cualquier
//    contraparte) suma el monto, no hay sugerencia. La exactitud al centavo es
//    la señal; la ambigüedad la anula.
//  - ≥2 facturas: el caso de una sola ya lo cubre el scoring normal.
//
// Puro y testeable; la ruta de match lo cablea y la UI aplica vía el PATCH
// `match-multiple` que ya existe (ConciliacionDetalle).
// ─────────────────────────────────────────────────────────────────────────────

export interface FacturaParaPagoJunto {
  id: string;
  /** RFC efectivo de la contraparte (customer o contraparteRfc). */
  rfc: string | null;
  /** Saldo pendiente de cobro/pago (total − porciones ya asignadas), en MXN. */
  saldo: number;
}

export interface PagoJunto {
  rfc: string;
  /** Asignación exacta por factura — lista lista para `match-multiple`. */
  asignaciones: Array<{ invoiceId: string; monto: number }>;
}

/** Máximo de facturas abiertas por contraparte que entran a la búsqueda. Con
 *  poda y salida temprana el costo es trivial; el tope protege el caso
 *  patológico (cientos de saldos idénticos). */
const MAX_FACTURAS_POR_GRUPO = 24;
/** Máximo de facturas en la sugerencia: un SPEI que salda 10 facturas es
 *  posible, pero la probabilidad de coincidencia numérica crece con el tamaño
 *  del subconjunto; 6 cubre la operación real sin invitar falsos exactos. */
const MAX_FACTURAS_EN_PAGO = 6;

const aCentavos = (n: number): number => Math.round(n * 100);

/**
 * Enumera subconjuntos (2..maxTam) de `saldos` que suman `objetivo` exacto.
 * Se detiene al encontrar `limite` soluciones (para declarar ambigüedad no
 * hace falta la lista completa). Índices sobre el arreglo dado.
 */
function subconjuntosExactos(
  saldos: number[],
  objetivo: number,
  limite: number,
  maxTam: number,
): number[][] {
  // Orden descendente con índice original para podar por suma de sufijo.
  const orden = saldos
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s > 0 && s <= objetivo)
    .sort((a, b) => b.s - a.s);
  const sufijo: number[] = new Array(orden.length + 1).fill(0);
  for (let k = orden.length - 1; k >= 0; k--) sufijo[k] = sufijo[k + 1] + orden[k].s;

  const soluciones: number[][] = [];
  const actual: number[] = [];

  function buscar(desde: number, resta: number): void {
    if (soluciones.length >= limite) return;
    if (resta === 0) {
      if (actual.length >= 2) soluciones.push([...actual]);
      return;
    }
    if (desde >= orden.length || sufijo[desde] < resta || actual.length >= maxTam) return;
    for (let k = desde; k < orden.length; k++) {
      if (soluciones.length >= limite) return;
      const { s, i } = orden[k];
      if (s > resta) continue;
      // Poda de duplicados: saltar valores repetidos en la misma posición del
      // árbol evita enumerar soluciones idénticas en montos (mismo multiset).
      if (k > desde && orden[k].s === orden[k - 1].s && !actual.includes(orden[k - 1].i)) continue;
      actual.push(i);
      buscar(k + 1, resta - s);
      actual.pop();
    }
  }

  buscar(0, objetivo);
  return soluciones;
}

/**
 * Sugerencia de pago junto para un movimiento de `montoTx` MXN (valor
 * absoluto). `facturas` son los candidatos abiertos (cualquier contraparte);
 * el agrupado por RFC ocurre aquí. Devuelve la única combinación exacta, o
 * null si no existe o hay más de una (ambigüedad = silencio).
 */
export function sugerirPagoJunto(
  montoTx: number,
  facturas: FacturaParaPagoJunto[],
): PagoJunto | null {
  const objetivo = aCentavos(Math.abs(montoTx));
  if (objetivo <= 0) return null;

  const porRfc = new Map<string, FacturaParaPagoJunto[]>();
  for (const f of facturas) {
    if (!f.rfc || f.saldo <= 0) continue;
    const g = porRfc.get(f.rfc) ?? [];
    if (g.length < MAX_FACTURAS_POR_GRUPO) g.push(f);
    porRfc.set(f.rfc, g);
  }

  let unica: PagoJunto | null = null;
  for (const [rfc, grupo] of porRfc) {
    const saldos = grupo.map((f) => aCentavos(f.saldo));
    const soluciones = subconjuntosExactos(saldos, objetivo, 2, MAX_FACTURAS_EN_PAGO);
    if (soluciones.length === 0) continue;
    if (soluciones.length > 1 || unica !== null) return null; // ambiguo
    unica = {
      rfc,
      asignaciones: soluciones[0].map((idx) => ({
        invoiceId: grupo[idx].id,
        monto: grupo[idx].saldo,
      })),
    };
  }
  return unica;
}
