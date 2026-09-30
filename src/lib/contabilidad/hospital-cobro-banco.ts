import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { cargarConfigContable, resolverCuenta } from "../hospital/contabilidad";
import type { PataCobro } from "./posting";

/**
 * EL DEPÓSITO BANCARIO DE UN COBRO QUE LA CAJA DEL HOSPITAL YA ASENTÓ.
 *
 * Con `HospConfig.contabilidadActiva`, la caja del hospital asienta cada cobro
 * en su momento: FONDOS_EN_TRANSITO (107.05, tarjeta/transferencia/cheque) o
 * CAJA (101.01, efectivo) contra CLIENTES (105.01) — o contra ANTICIPOS si es
 * un depósito del paciente. Días después el dinero llega al banco y la
 * conciliación del hub lo liga a la factura del paciente. El motor abonaba
 * entonces CLIENTES por segunda vez, y 107.05 no se acreditaba nunca: la CxC
 * quedaba corta y 107.05 crecía para siempre.
 *
 * Acordado en docs/HOSPITAL.md: el abono del depósito se PARTE. Primero sale
 * de lo que la caja dejó pendiente —107.05 si el depósito no es en efectivo,
 * CAJA si lo es— y sólo el resto va a CLIENTES/ANTICIPOS como siempre (lo
 * cobrado antes de operar caja ya tenía su derecho de cobro creado por el
 * CFDI).
 *
 * «Lo pendiente» se lee del LIBRO, no del estado de los cobros: el saldo de la
 * cuenta a la fecha del depósito, sin los asientos que este postMonth regenera
 * (que están por reescribirse), menos lo que ya consumieron los depósitos
 * anteriores del mismo mes. Así es regenerable —re-postear el mes da lo
 * mismo— y el tope es exacto: 107.05 se acredita sólo por lo que alguien le
 * cargó, nunca queda con saldo acreedor. El orden es el de las fechas, que es
 * el FIFO del contrato.
 *
 * Apagada la contabilidad del hospital, el contexto viene vacío y el motor no
 * cambia de conducta.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export type CuentaCaja = "transito" | "caja";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Un movimiento de la cuenta dentro del mes, con signo (cargo +, abono −). */
export interface MovimientoCuenta {
  fecha: Date;
  delta: number;
}

/**
 * Lo que queda disponible en 107.05 y en CAJA para cubrir depósitos. PURO
 * (salvo su propio estado): se construye con el saldo al inicio del mes y los
 * movimientos del mes que NO regenera el motor.
 */
export class DisponibleHospital {
  private consumido: Record<CuentaCaja, number> = { transito: 0, caja: 0 };

  constructor(
    private readonly inicial: Record<CuentaCaja, number>,
    private readonly movimientos: Record<CuentaCaja, MovimientoCuenta[]>,
  ) {}

  /** Saldo deudor de la cuenta a la fecha (inclusive), menos lo ya consumido; nunca negativo. */
  disponible(cuenta: CuentaCaja, fecha: Date): number {
    const delMes = this.movimientos[cuenta].filter((m) => m.fecha.getTime() <= fecha.getTime()).reduce((s, m) => s + m.delta, 0);
    return Math.max(0, r2(this.inicial[cuenta] + delMes - this.consumido[cuenta]));
  }

  /** Toma hasta `monto` de la cuenta a esa fecha. Devuelve lo que alcanzó. */
  cubrir(cuenta: CuentaCaja, fecha: Date, monto: number): number {
    const tomado = r2(Math.min(Math.max(0, monto), this.disponible(cuenta, fecha)));
    this.consumido[cuenta] = r2(this.consumido[cuenta] + tomado);
    return tomado;
  }
}

export interface ContextoCobroBancoHospital {
  activa: boolean;
  cuentas: Record<CuentaCaja, { id: string } | null>;
  disponible: DisponibleHospital | null;
}

export const SIN_COBRO_BANCO_HOSPITAL: ContextoCobroBancoHospital = {
  activa: false,
  cuentas: { transito: null, caja: null },
  disponible: null,
};

/**
 * Las patas del cobro bancario cuando la caja del hospital ya asentó parte. PURA.
 *
 *   DR Bancos       / AB 107.05 o CAJA   ← lo que la caja dejó pendiente
 *   (el resto)      → patasDeCobro de siempre
 *
 * Lo cubierto se descuenta primero de lo asignado a facturas (es lo que la
 * caja abonó a CLIENTES) y después del sobrante (lo que abonó a ANTICIPOS).
 */
export function partirCobroHospital(opts: {
  absAmount: number;
  asignado: number;
  sobrante: number;
  cubierto: number;
  ctaBancoId: string;
  ctaCajaHospitalId: string;
}): { patas: PataCobro[]; resto: { absAmount: number; asignado: number; sobrante: number } } {
  const cubierto = r2(Math.min(Math.max(0, opts.cubierto), opts.absAmount));
  const asignado = r2(Math.max(0, opts.asignado - cubierto));
  const sobrante = r2(Math.max(0, opts.sobrante - Math.max(0, cubierto - opts.asignado)));
  const patas: PataCobro[] =
    cubierto > 0.005
      ? [
          { chartAccountId: opts.ctaBancoId, monto: cubierto, tipo: "CARGO" },
          { chartAccountId: opts.ctaCajaHospitalId, monto: cubierto, tipo: "ABONO" },
        ]
      : [];
  return { patas, resto: { absAmount: r2(opts.absAmount - cubierto), asignado, sobrante } };
}

/**
 * Carga el contexto para postMonth: las cuentas del módulo (resueltas con el
 * mismo mapa del contador que usa la caja) y su saldo, excluyendo lo que este
 * postMonth está por regenerar.
 */
export async function cargarContextoCobroBancoHospital(
  companyId: string,
  periodo: { year: number; month: number; start: Date; end: Date },
  fuentesRegeneradas: readonly string[],
  opts: { db?: Db } = {},
): Promise<ContextoCobroBancoHospital> {
  const db = opts.db ?? prisma;
  const config = await cargarConfigContable(db, companyId);
  if (!config.activa) return SIN_COBRO_BANCO_HOSPITAL;

  const [transito, caja] = await Promise.all([
    resolverCuenta(db, companyId, "FONDOS_EN_TRANSITO", { config: config.cuentas }),
    resolverCuenta(db, companyId, "CAJA", { config: config.cuentas }),
  ]);

  const noRegenerado = {
    NOT: { fuente: { in: [...fuentesRegeneradas] as never[] }, year: periodo.year, month: periodo.month },
  };
  const lineas = await db.accountingEntry.findMany({
    where: { companyId, chartAccountId: { in: [transito.id, caja.id] }, fecha: { lt: periodo.end }, ...noRegenerado },
    select: { chartAccountId: true, fecha: true, monto: true, tipo: true },
  });

  const inicial: Record<CuentaCaja, number> = { transito: 0, caja: 0 };
  const movimientos: Record<CuentaCaja, MovimientoCuenta[]> = { transito: [], caja: [] };
  for (const l of lineas) {
    const cuenta: CuentaCaja = l.chartAccountId === transito.id ? "transito" : "caja";
    const delta = (l.tipo === "CARGO" ? 1 : -1) * Number(l.monto);
    if (l.fecha < periodo.start) inicial[cuenta] = r2(inicial[cuenta] + delta);
    else movimientos[cuenta].push({ fecha: l.fecha, delta });
  }

  return {
    activa: true,
    cuentas: { transito: { id: transito.id }, caja: { id: caja.id } },
    disponible: new DisponibleHospital(inicial, movimientos),
  };
}
