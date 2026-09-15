// ─────────────────────────────────────────────────────────────────────────────
// Buscar el pago original de una devolución, contra la base.
//
// La lógica PURA (qué par es válido y cuánto pesa) vive en devoluciones.ts;
// aquí sólo está la consulta, en un único lugar, porque la proponen dos
// pantallas: el archivo (GET /api/bancos/[id], una página de movimientos) y
// LA MESA (GET /api/bancos/[id]/match?txId=, un movimiento). Vivía inline en
// el archivo, así que la mesa —que es donde se trabaja— no la tenía: había que
// salirse a otro tab para resolver un rebote.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import {
  DEVOLUCION_VENTANA_DIAS,
  elegirOrigenDevolucion,
  esDescripcionDevolucion,
  puntuarParDevolucion,
  validarParDevolucion,
  type MovimientoPar,
} from "./devoluciones";

/** El pago original que se propone para una devolución. */
export interface OrigenPropuesto {
  origenId: string;
  descripcion: string;
  fecha: Date;
  monto: number;
}

/** Lo mínimo para buscarle origen a un movimiento. */
export interface CandidataDevolucion extends MovimientoPar {
  status: string;
  devolucionDeId: string | null;
  /** El otro lado si YA está vinculado (la relación inversa). */
  devolucionPor?: { id: string } | null;
}

/**
 * ¿Vale la pena buscarle origen? Ya vinculado o conciliado, no.
 *
 * `exigirDescripcion` es una concesión al COSTO, no al criterio: la lista del
 * archivo pediría una consulta por renglón (50 por página) si mirara todos, así
 * que ahí sólo se examinan los que dicen «devuelto». En la mesa se mira UN
 * movimiento, la consulta es una, y no hace falta que el banco lo diga: un
 * depósito equivocado que regresa no trae la palabra en ninguna parte. La
 * fuerza de la señal la sigue poniendo el score (referencia idéntica y monto
 * opuesto exacto), que sin la descripción sólo llega a 2 por la referencia.
 */
export function pareceDevolucionSuelta(
  t: CandidataDevolucion,
  { exigirDescripcion = true }: { exigirDescripcion?: boolean } = {},
): boolean {
  if (exigirDescripcion && !esDescripcionDevolucion(t.descripcion)) return false;
  return !t.devolucionDeId && !t.devolucionPor && t.status !== "MATCHED";
}

/**
 * El pago original de esta devolución, o null. Busca en la MISMA cuenta el
 * monto opuesto exacto dentro de la ventana, y sólo propone con señal fuerte
 * (referencia idéntica, o descripción + cercanía): el humano decide.
 */
export async function buscarOrigenDevolucion(dev: CandidataDevolucion): Promise<OrigenPropuesto | null> {
  const desde = new Date(dev.fecha.getTime() - DEVOLUCION_VENTANA_DIAS * 86400000);
  const posibles = (
    await prisma.bankTransaction.findMany({
      where: {
        bankAccountId: dev.bankAccountId,
        id: { not: dev.id },
        fecha: { gte: desde, lte: dev.fecha },
        // Monto opuesto exacto (el validador re-verifica con tolerancia).
        monto: -dev.monto,
        devolucionDeId: null,
        devolucionPor: { is: null },
      },
      select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, referencia: true },
      take: 20,
    })
  ).map((p) => ({ ...p, monto: Number(p.monto) }));

  const origen = elegirOrigenDevolucion(dev, posibles);
  if (!origen) return null;
  const full = posibles.find((p) => p.id === origen.id)!;
  return { origenId: full.id, descripcion: full.descripcion, fecha: full.fecha, monto: full.monto };
}

/** Lo mismo para una lista (el archivo): id de la devolución → su origen. */
export async function sugerenciasDevolucion(
  movimientos: CandidataDevolucion[],
): Promise<Record<string, OrigenPropuesto>> {
  const out: Record<string, OrigenPropuesto> = {};
  for (const dev of movimientos.filter((m) => pareceDevolucionSuelta(m))) {
    const origen = await buscarOrigenDevolucion(dev);
    if (origen) out[dev.id] = origen;
  }
  return out;
}

/**
 * Al revés: el REBOTE POSTERIOR de este pago, o null.
 *
 * Buscar sólo hacia atrás dejaba el par a medias en la pantalla. Quien
 * concilia ve los dos renglones y resuelve el que tiene enfrente: si abre el
 * pago (el que salió primero) no había nada que ofrecerle, y el movimiento
 * «se quedaba en la mesa» aunque su rebote ya estuviera resuelto. El par se
 * vincula desde cualquiera de los dos lados; quien manda sigue siendo el
 * rebote, que es donde vive `devolucionDeId`.
 *
 * Mismo criterio y mismo score, con los papeles cambiados: el candidato es la
 * devolución y este movimiento el origen.
 */
export async function buscarRebotePosterior(origen: CandidataDevolucion): Promise<OrigenPropuesto | null> {
  const hasta = new Date(origen.fecha.getTime() + DEVOLUCION_VENTANA_DIAS * 86400000);
  const posibles = (
    await prisma.bankTransaction.findMany({
      where: {
        bankAccountId: origen.bankAccountId,
        id: { not: origen.id },
        fecha: { gte: origen.fecha, lte: hasta },
        monto: -origen.monto,
        devolucionDeId: null,
        devolucionPor: { is: null },
        // Un rebote ya conciliado con su factura no es un rebote.
        status: { not: "MATCHED" },
      },
      select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, referencia: true },
      take: 20,
    })
  ).map((p) => ({ ...p, monto: Number(p.monto) }));

  let mejor: (MovimientoPar & { descripcion: string }) | null = null;
  let mejorScore = 0;
  for (const c of posibles) {
    if (validarParDevolucion(c, origen) !== null) continue;
    const score = puntuarParDevolucion(c, origen);
    if (score > mejorScore) {
      mejor = c;
      mejorScore = score;
    }
  }
  // El mismo umbral que elegirOrigenDevolucion: sin señal fuerte no se propone.
  return mejorScore >= 2 && mejor
    ? { origenId: mejor.id, descripcion: mejor.descripcion, fecha: mejor.fecha, monto: mejor.monto }
    : null;
}

/** Una opción para vincular a mano, con el papel que jugaría el movimiento abierto. */
export interface CandidatoPar extends OrigenPropuesto {
  /** Si el movimiento abierto sería el rebote (el par es el pago) o al revés. */
  rol: "rebote" | "pago";
}

/**
 * Los pares POSIBLES cuando no hay uno que proponer.
 *
 * La propuesta automática exige señal fuerte (referencia idéntica, o la palabra
 * del banco más cercanía) porque va a actuar sola. Un par real puede no llegar
 * a ese umbral —un depósito equivocado que regresa, sin referencia común y sin
 * que el banco escriba «devuelto»— y entonces no había NADA que hacer: ni
 * propuesta ni forma de vincularlos a mano. Aquí se lista lo que el validador
 * acepta (misma cuenta, monto opuesto al centavo, la devolución no antes que su
 * pago, dentro de la ventana) y elige una persona, que es quien sabe.
 */
export async function candidatosDePar(tx: CandidataDevolucion, limite = 8): Promise<CandidatoPar[]> {
  if (tx.devolucionDeId || tx.devolucionPor) return [];
  const desde = new Date(tx.fecha.getTime() - DEVOLUCION_VENTANA_DIAS * 86400000);
  const hasta = new Date(tx.fecha.getTime() + DEVOLUCION_VENTANA_DIAS * 86400000);
  const posibles = (
    await prisma.bankTransaction.findMany({
      where: {
        bankAccountId: tx.bankAccountId,
        id: { not: tx.id },
        fecha: { gte: desde, lte: hasta },
        monto: -tx.monto,
        devolucionDeId: null,
        devolucionPor: { is: null },
      },
      select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, referencia: true, status: true },
      orderBy: { fecha: "desc" },
      take: limite * 3,
    })
  ).map((p) => ({ ...p, monto: Number(p.monto) }));

  const out: CandidatoPar[] = [];
  for (const c of posibles) {
    // Como rebote de este pago: el candidato es la devolución. Uno ya cruzado
    // con su factura no es un rebote.
    if (c.status !== "MATCHED" && validarParDevolucion(c, tx) === null) {
      out.push({ origenId: c.id, descripcion: c.descripcion, fecha: c.fecha, monto: c.monto, rol: "pago" });
      continue;
    }
    // O como el pago que este movimiento devuelve. Aquí el candidato SÍ puede
    // estar conciliado: vincular deshace su conciliación, que es el punto.
    if (validarParDevolucion(tx, c) === null) {
      out.push({ origenId: c.id, descripcion: c.descripcion, fecha: c.fecha, monto: c.monto, rol: "rebote" });
    }
  }
  return out.slice(0, limite);
}
