// ─────────────────────────────────────────────────────────────────────────────
// La comisión pertenece a su transferencia.
//
// Banco del Bajío cobra la comisión del SPEI como un movimiento APARTE, pero le
// pone la MISMA clave de rastreo y la misma referencia del envío que la generó:
//
//   -$4,725.60  SPEI Enviado: | ... | Clave de Rastreo: BB27726020704
//      -$7.xx   Comision por Transferencia - Envio ; (SPEI; Banca por Internet)
//               | Referencia: 2772602 | Clave de Rastreo: BB27726020704
//
// Sin ese vínculo, cada comisión queda como un egreso suelto que alguien tiene
// que mirar y descartar a mano todos los meses. Una cuenta con 200 SPEI al mes
// son 200 renglones de ruido que nunca van a empatar con una factura.
//
// QUÉ NO HACE: no marca la comisión como IGNORED ni la neteea contra el envío.
// La comisión bancaria es un GASTO REAL y deducible — tiene su propio CFDI del
// banco al final del mes. Lo que hace es DECIR DE DÓNDE VIENE, para que la
// conciliación deje de ofrecerla como si fuera un pago a proveedor.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

import { esComisionDeTransferencia } from "./spei-descripcion";

export interface MovimientoComision {
  id: string;
  fecha: Date;
  monto: number;
  descripcion: string;
  claveRastreo?: string | null;
  referencia?: string | null;
}

/** Días de tolerancia entre la transferencia y su cobro de comisión. */
export const VENTANA_DIAS_COMISION = 3;

export interface VinculoComision {
  comisionId: string;
  transferenciaId: string;
  /** Por qué se emparejaron: la clave de rastreo es concluyente. */
  por: "claveRastreo" | "referencia";
}

/**
 * Empareja cada comisión con la transferencia que la generó.
 *
 * DOS CANDADOS QUE NO SON OPCIONALES:
 *
 *   · La comisión SIEMPRE es más chica que su transferencia. Sin esto, dos
 *     envíos del mismo día que compartieran referencia podrían emparejarse
 *     entre sí y "desaparecer" un pago real de la conciliación.
 *
 *   · Ambas son EGRESOS. Una comisión no cuelga de un depósito.
 *
 * La clave de rastreo manda sobre la referencia: la referencia numérica es de
 * 7 dígitos y se repite entre bancos y entre meses, así que sola no basta —
 * sólo se acepta dentro de la ventana de días y si no hubo empate por clave.
 */
export function vincularComisiones(movs: readonly MovimientoComision[]): VinculoComision[] {
  const comisiones = movs.filter((m) => m.monto < 0 && esComisionDeTransferencia(m.descripcion));
  if (comisiones.length === 0) return [];

  // Candidatas a "transferencia": egresos que NO son comisión.
  const transferencias = movs.filter(
    (m) => m.monto < 0 && !esComisionDeTransferencia(m.descripcion)
  );
  if (transferencias.length === 0) return [];

  const porClave = new Map<string, MovimientoComision[]>();
  const porRef = new Map<string, MovimientoComision[]>();
  for (const t of transferencias) {
    if (t.claveRastreo) push(porClave, t.claveRastreo.toUpperCase(), t);
    if (t.referencia) push(porRef, t.referencia, t);
  }

  const out: VinculoComision[] = [];
  for (const c of comisiones) {
    const porClaveHit = c.claveRastreo
      ? elegir(porClave.get(c.claveRastreo.toUpperCase()), c, Infinity)
      : null;
    if (porClaveHit) {
      out.push({ comisionId: c.id, transferenciaId: porClaveHit.id, por: "claveRastreo" });
      continue;
    }
    const porRefHit = c.referencia
      ? elegir(porRef.get(c.referencia), c, VENTANA_DIAS_COMISION)
      : null;
    if (porRefHit) {
      out.push({ comisionId: c.id, transferenciaId: porRefHit.id, por: "referencia" });
    }
  }
  return out;
}

function push(m: Map<string, MovimientoComision[]>, k: string, v: MovimientoComision): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * De las candidatas, la transferencia MAYOR que la comisión y dentro de la
 * ventana. Si quedan varias (raro), gana la más cercana en fecha; ante un
 * empate perfecto se devuelve null en vez de adivinar — colgar la comisión de
 * la transferencia equivocada es peor que dejarla suelta.
 */
function elegir(
  candidatas: MovimientoComision[] | undefined,
  comision: MovimientoComision,
  ventanaDias: number
): MovimientoComision | null {
  if (!candidatas || candidatas.length === 0) return null;
  const viables = candidatas.filter((t) => {
    if (Math.abs(t.monto) <= Math.abs(comision.monto)) return false;
    const dias = Math.abs(t.fecha.getTime() - comision.fecha.getTime()) / 86_400_000;
    return dias <= ventanaDias;
  });
  if (viables.length === 0) return null;
  if (viables.length === 1) return viables[0];

  const dist = (t: MovimientoComision) =>
    Math.abs(t.fecha.getTime() - comision.fecha.getTime());
  const ordenadas = [...viables].sort((a, b) => dist(a) - dist(b));
  // Empate exacto entre dos transferencias distintas: no se adivina.
  if (dist(ordenadas[0]) === dist(ordenadas[1])) return null;
  return ordenadas[0];
}
