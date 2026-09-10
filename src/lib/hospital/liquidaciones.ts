// ─────────────────────────────────────────────────────────────────────────────
// La liquidación del adquirente: el lote que el banco sí ve.
//
// El adquirente no deposita cobro por cobro. Junta las operaciones de un día,
// le resta su comisión más el IVA de esa comisión, le descuenta los
// contracargos que hayan caído, y deposita UN neto dos días hábiles después.
// Por eso el estado de cuenta del hospital tiene un movimiento de $312,480.55
// que no se parece a ninguna factura: es la suma de treinta vouchers menos lo
// que se quedó la terminal.
//
// La identidad que tiene que cerrar es una sola:
//
//     bruto − contracargos − comisión − IVA de comisión = neto
//
// y el neto es el movimiento bancario. Cuando cierra, treinta cobros quedan
// explicados de un golpe; cuando no cierra, la diferencia tiene nombre y monto
// en vez de ser «pendiente de aclarar».
//
// LO QUE ESTE MÓDULO ASIENTA Y LO QUE NO. El movimiento bancario conciliado en
// el hub carga BANCOS contra FONDOS_EN_TRANSITO por el NETO. Eso deja en
// 107.05 un residuo exacto: la comisión y su IVA, que nunca pasaron por el
// banco. Limpiarlo es lo único que este módulo asienta de la liquidación
// (ver `planesLiquidacion` en asientos.ts). Así el módulo sigue sin cargar
// BANCOS nunca, y 107.05 termina en cero por lote.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCobroEstado, HospFormaPago, Prisma, PrismaClient } from "@prisma/client";
import { asentarLiquidacion } from "./asientos";
import { HospitalError } from "./errores";
import { claveDia, finDiaLocal, inicioDiaLocal, sumarDias } from "./tz";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

/** IVA de la comisión del adquirente: servicio financiero gravado a la tasa general. */
export const IVA_COMISION = 0.16;

/**
 * Lo que se acepta de diferencia al cuadrar. El adquirente redondea la
 * comisión operación por operación, así que un lote de treinta vouchers puede
 * traer unos centavos de diferencia contra la multiplicación directa. Cinco
 * centavos aceptan ese redondeo sin dejar pasar un cobro faltante, que nunca
 * es de centavos.
 */
export const TOLERANCIA_CUADRE = 0.05;

// ─── El cuadre ───────────────────────────────────────────────────────────────

export interface CifrasLiquidacion {
  bruto: number;
  contracargos: number;
  comision: number;
  ivaComision: number;
  neto: number;
}

export interface Cuadre extends CifrasLiquidacion {
  /** neto declarado − neto que sale de las otras cuatro cifras. */
  diferencia: number;
  cuadra: boolean;
}

export function cuadreDe(c: CifrasLiquidacion): Cuadre {
  const bruto = r2(c.bruto);
  const contracargos = r2(c.contracargos);
  const comision = r2(c.comision);
  const ivaComision = r2(c.ivaComision);
  const neto = r2(c.neto);
  const diferencia = r2(neto - r2(bruto - contracargos - comision - ivaComision));
  return {
    bruto,
    contracargos,
    comision,
    ivaComision,
    neto,
    diferencia,
    cuadra: Math.abs(diferencia) <= TOLERANCIA_CUADRE,
  };
}

/** La comisión que TENDRÍA que cobrar el adquirente según la tasa pactada. */
export function comisionEsperada(bruto: number, tasa: number | null | undefined): { comision: number; ivaComision: number; neto: number } | null {
  if (tasa == null || !(tasa > 0)) return null;
  const comision = r2(bruto * Number(tasa));
  const ivaComision = r2(comision * IVA_COMISION);
  return { comision, ivaComision, neto: r2(bruto - comision - ivaComision) };
}

// ─── Sugerir el lote ─────────────────────────────────────────────────────────

export interface DiaSugerido {
  /** Día de OPERACIÓN de los cobros, no el de depósito. */
  dia: string;
  cobroIds: string[];
  bruto: number;
  /** Neto que se esperaría con la tasa pactada; null si la afiliación no la trae. */
  netoEsperado: number | null;
  /** |netoEsperado − neto del banco|; null cuando no hay tasa con qué estimar. */
  distancia: number | null;
}

type CobroPendiente = {
  id: string;
  fecha: Date;
  monto: number | { toString(): string };
};

/**
 * Agrupa los cobros pendientes por día de operación y los ordena por qué tan
 * cerca queda su neto estimado del depósito que llegó al banco.
 *
 * Es una SUGERENCIA, no una asignación: la liquidación la confirma una
 * persona. Es la misma regla que la conciliación bancaria del hub —lo que no
 * se puede resolver con certeza se deja señalado, nunca se adivina—, y aquí
 * importa el doble, porque un lote mal armado marca como depositados cobros
 * que el adquirente todavía no paga.
 */
export function sugerirDias(cobros: CobroPendiente[], netoBanco: number, tasa: number | null | undefined): DiaSugerido[] {
  const porDia = new Map<string, CobroPendiente[]>();
  for (const c of cobros) {
    const dia = claveDia(c.fecha);
    porDia.set(dia, [...(porDia.get(dia) ?? []), c]);
  }

  const dias: DiaSugerido[] = [...porDia.entries()].map(([dia, delDia]) => {
    const bruto = r2(delDia.reduce((s, c) => s + Number(c.monto), 0));
    const esperado = comisionEsperada(bruto, tasa);
    return {
      dia,
      cobroIds: delDia.map((c) => c.id),
      bruto,
      netoEsperado: esperado?.neto ?? null,
      distancia: esperado ? r2(Math.abs(esperado.neto - r2(netoBanco))) : null,
    };
  });

  return dias.sort((a, b) => {
    if (a.distancia == null && b.distancia == null) return a.dia.localeCompare(b.dia);
    if (a.distancia == null) return 1;
    if (b.distancia == null) return -1;
    return a.distancia - b.distancia;
  });
}

/**
 * Los cobros con tarjeta de una afiliación que todavía no entran a ninguna
 * liquidación, dentro de la ventana en la que el adquirente pudo haberlos
 * depositado. `diasVentana` cubre el rezago típico (liquida a dos días
 * hábiles) más el fin de semana.
 */
export async function cobrosPendientes(
  db: Db,
  companyId: string,
  afiliacionId: string,
  fechaDeposito: Date,
  diasVentana = 10
): Promise<Array<{ id: string; fecha: Date; monto: number }>> {
  const filas = await db.hospCobro.findMany({
    where: {
      companyId,
      afiliacionId,
      liquidacionId: null,
      estado: "COBRADO",
      fecha: { gte: inicioDiaLocal(sumarDias(fechaDeposito, -diasVentana)), lte: finDiaLocal(fechaDeposito) },
    },
    select: { id: true, fecha: true, monto: true },
    orderBy: { fecha: "asc" },
  });
  return filas.map((f) => ({ id: f.id, fecha: f.fecha, monto: r2(Number(f.monto)) }));
}

// ─── Armar la liquidación ────────────────────────────────────────────────────

export interface LiquidacionInput extends CifrasLiquidacion {
  afiliacionId: string;
  fecha: Date;
  cobroIds: string[];
  bankTransactionId?: string | null;
  notas?: string | null;
}

/**
 * Valida el lote antes de escribirlo: que los cobros existan, sean de esta
 * empresa y de esta afiliación, que ninguno esté ya liquidado, que su suma sea
 * el bruto declarado, y que la identidad del lote cierre.
 *
 * El orden importa. Primero se comprueba que los cobros son los que dicen ser
 * y luego que las cifras cierran, porque el error que se comete en la práctica
 * es marcar un cobro ajeno para forzar el cuadre.
 */
export async function validarLiquidacion(db: Db, companyId: string, input: LiquidacionInput): Promise<Cuadre> {
  if (!input.cobroIds.length) throw new HospitalError(400, "Una liquidación sin cobros no explica nada: hay que decir qué vouchers la componen.");

  const cobros = await db.hospCobro.findMany({
    where: { id: { in: input.cobroIds }, companyId },
    select: { id: true, monto: true, afiliacionId: true, liquidacionId: true, estado: true, formaPago: true },
  });

  if (cobros.length !== input.cobroIds.length) {
    throw new HospitalError(400, "Algún cobro de la liquidación no existe o es de otra empresa.");
  }
  const ajeno = cobros.find((c) => c.afiliacionId !== input.afiliacionId);
  if (ajeno) throw new HospitalError(400, "Hay un cobro de otra afiliación en el lote: el adquirente liquida cada afiliación por separado.");
  const yaLiquidado = cobros.find((c) => c.liquidacionId);
  if (yaLiquidado) throw new HospitalError(400, "Hay un cobro que ya pertenece a otra liquidación.");
  const noCobrado = cobros.find((c) => c.estado !== "COBRADO");
  if (noCobrado) throw new HospitalError(400, "Sólo entran a la liquidación los cobros en estado COBRADO.");
  const noTarjeta = cobros.find((c: { formaPago: HospFormaPago }) => c.formaPago !== "TARJETA");
  if (noTarjeta) throw new HospitalError(400, "El adquirente sólo liquida cobros con tarjeta.");

  const suma = r2(cobros.reduce((s, c) => s + Number(c.monto), 0));
  if (Math.abs(suma - r2(input.bruto)) > TOLERANCIA_CUADRE) {
    throw new HospitalError(
      400,
      `Los cobros del lote suman ${suma.toFixed(2)} y el bruto declarado es ${r2(input.bruto).toFixed(2)}. Falta o sobra un voucher.`
    );
  }

  const cuadre = cuadreDe(input);
  if (!cuadre.cuadra) {
    throw new HospitalError(
      400,
      `La liquidación no cierra por ${cuadre.diferencia.toFixed(2)}: bruto ${cuadre.bruto.toFixed(2)} − contracargos ${cuadre.contracargos.toFixed(2)} − comisión ${cuadre.comision.toFixed(2)} − IVA ${cuadre.ivaComision.toFixed(2)} debería dar ${cuadre.neto.toFixed(2)}.`
    );
  }
  return cuadre;
}

// ─── Serialización ───────────────────────────────────────────────────────────

export function liquidacionResumen(l: {
  id: string;
  fecha: Date;
  afiliacionId: string;
  bruto: number | { toString(): string };
  contracargos: number | { toString(): string };
  comision: number | { toString(): string };
  ivaComision: number | { toString(): string };
  neto: number | { toString(): string };
  bankTransactionId: string | null;
  conciliadoAt: Date | null;
  asientoAt: Date | null;
  notas: string | null;
  createdAt: Date;
  cobros?: Array<{ estado: HospCobroEstado }>;
}) {
  const cifras = cuadreDe({
    bruto: Number(l.bruto),
    contracargos: Number(l.contracargos),
    comision: Number(l.comision),
    ivaComision: Number(l.ivaComision),
    neto: Number(l.neto),
  });
  return {
    id: l.id,
    fecha: l.fecha,
    afiliacionId: l.afiliacionId,
    ...cifras,
    cobros: l.cobros?.length ?? null,
    bankTransactionId: l.bankTransactionId,
    conciliadoAt: l.conciliadoAt,
    asientoAt: l.asientoAt,
    notas: l.notas,
    createdAt: l.createdAt,
  };
}

// ─── Escritura ───────────────────────────────────────────────────────────────

export interface CrearLiquidacionArgs extends LiquidacionInput {
  companyId: string;
}

/**
 * Escribe el lote y marca sus cobros como DEPOSITADOS, todo en una
 * transacción: un lote a medias dejaría cobros marcados contra una
 * liquidación que no existe, que es peor que no haberlo intentado.
 */
export async function crearLiquidacion(db: PrismaClient, args: CrearLiquidacionArgs) {
  if (Number.isNaN(args.fecha.getTime())) throw new HospitalError(400, "Fecha inválida");

  return db.$transaction(async (tx) => {
    const af = await tx.hospAfiliacion.findUnique({ where: { id: args.afiliacionId }, select: { companyId: true, numero: true } });
    if (!af || af.companyId !== args.companyId) throw new HospitalError(404, "Afiliación no encontrada");

    if (args.bankTransactionId) {
      const mov = await tx.bankTransaction.findUnique({ where: { id: args.bankTransactionId }, select: { companyId: true } });
      if (!mov || mov.companyId !== args.companyId) throw new HospitalError(404, "Movimiento bancario no encontrado");
      const yaUsado = await tx.hospLiquidacion.findUnique({ where: { bankTransactionId: args.bankTransactionId }, select: { id: true } });
      if (yaUsado) throw new HospitalError(409, "Ese movimiento bancario ya está ligado a otra liquidación.");
    }

    const cuadre = await validarLiquidacion(tx, args.companyId, args);

    const liquidacion = await tx.hospLiquidacion.create({
      data: {
        companyId: args.companyId,
        afiliacionId: args.afiliacionId,
        fecha: args.fecha,
        bruto: cuadre.bruto,
        contracargos: cuadre.contracargos,
        comision: cuadre.comision,
        ivaComision: cuadre.ivaComision,
        neto: cuadre.neto,
        bankTransactionId: args.bankTransactionId ?? null,
        conciliadoAt: args.bankTransactionId ? new Date() : null,
        notas: args.notas?.trim() || null,
      },
    });

    await tx.hospCobro.updateMany({
      where: { id: { in: args.cobroIds }, companyId: args.companyId },
      data: { liquidacionId: liquidacion.id, estado: "DEPOSITADO", depositadoAt: args.fecha },
    });

    // ── Contabilidad (P3c): sólo la comisión y su IVA. El neto lo baja a
    //    BANCOS la conciliación del hub, contra esta misma 107.05.
    await asentarLiquidacion(tx, { ...liquidacion, afiliacion: af.numero });
    return tx.hospLiquidacion.findUniqueOrThrow({ where: { id: liquidacion.id } });
  });
}
