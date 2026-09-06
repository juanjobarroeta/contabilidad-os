// ─────────────────────────────────────────────────────────────────────────────
// Depósitos del paciente (garantía / anticipo al ingreso).
//
// Un depósito nace RECIBIDO y termina APLICADO a la cuenta (baja lo que el
// paciente debe), DEVUELTO o CANCELADO (se registró por error). Cada cambio
// deja su asiento con fuente HOSPITAL dentro de la misma transacción (ver
// asientos.ts) cuando la contabilidad está activa; la cuenta del paciente los
// enseña y resta los vigentes (recibidos + aplicados) al saldo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDepositoEstado, HospFormaPago, PrismaClient } from "@prisma/client";
import { asentarDeposito } from "./asientos";
import { HospitalError } from "./errores";
import { r2 } from "./util";

export const FORMAS_PAGO = ["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CHEQUE"] as const;
export const ESTADOS_DESTINO = ["APLICADO", "DEVUELTO", "CANCELADO"] as const;

export const TRANSICIONES_DEPOSITO: Record<HospDepositoEstado, HospDepositoEstado[]> = {
  RECIBIDO: ["APLICADO", "DEVUELTO", "CANCELADO"],
  APLICADO: [],
  DEVUELTO: [],
  CANCELADO: [],
};

export interface ResumenDepositos {
  recibidos: number;
  aplicados: number;
  devueltos: number;
  cancelados: number;
  /** Lo que sigue en poder del hospital a favor del paciente: recibidos + aplicados. */
  vigentes: number;
}

export function resumenDepositos(depositos: Array<{ estado: HospDepositoEstado; monto: number | { toString(): string } }>): ResumenDepositos {
  const suma = (estado: HospDepositoEstado) => r2(depositos.filter((d) => d.estado === estado).reduce((s, d) => s + Number(d.monto), 0));
  const recibidos = suma("RECIBIDO");
  const aplicados = suma("APLICADO");
  return { recibidos, aplicados, devueltos: suma("DEVUELTO"), cancelados: suma("CANCELADO"), vigentes: r2(recibidos + aplicados) };
}

export function depositoResumen(d: {
  id: string;
  episodioId: string;
  fecha: Date;
  monto: number | { toString(): string };
  formaPago: HospFormaPago;
  referencia: string | null;
  estado: HospDepositoEstado;
  aplicadoAt: Date | null;
  devueltoAt: Date | null;
  asientoAt: Date | null;
  notas: string | null;
  createdAt: Date;
}) {
  return {
    id: d.id,
    episodioId: d.episodioId,
    fecha: d.fecha,
    monto: r2(Number(d.monto)),
    formaPago: d.formaPago,
    referencia: d.referencia,
    estado: d.estado,
    aplicadoAt: d.aplicadoAt,
    devueltoAt: d.devueltoAt,
    asientoAt: d.asientoAt,
    notas: d.notas,
    createdAt: d.createdAt,
  };
}

export interface CrearDepositoArgs {
  companyId: string;
  episodioId: string;
  fecha: Date;
  monto: number;
  formaPago: HospFormaPago;
  referencia?: string | null;
  notas?: string | null;
  usuarioId?: string | null;
}

export async function crearDeposito(db: PrismaClient, args: CrearDepositoArgs) {
  const monto = r2(Number(args.monto));
  if (!(monto > 0)) throw new HospitalError(400, "El monto del depósito debe ser mayor que cero");
  if (Number.isNaN(args.fecha.getTime())) throw new HospitalError(400, "Fecha inválida");

  return db.$transaction(async (tx) => {
    const episodio = await tx.hospEpisodio.findUnique({ where: { id: args.episodioId }, select: { id: true, companyId: true, folio: true, estado: true } });
    if (!episodio || episodio.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
    if (episodio.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${episodio.folio} está cancelado: no recibe depósitos`);

    const deposito = await tx.hospDeposito.create({
      data: {
        companyId: args.companyId,
        episodioId: episodio.id,
        fecha: args.fecha,
        monto,
        formaPago: args.formaPago,
        referencia: args.referencia?.trim() || null,
        notas: args.notas?.trim() || null,
        recibidoPorUserId: args.usuarioId ?? null,
      },
    });
    // ── Contabilidad (P3c): CAJA/BANCOS contra ANTICIPOS_PACIENTES, si está activa ──
    await asentarDeposito(tx, { ...deposito, folio: episodio.folio });
    return tx.hospDeposito.findUniqueOrThrow({ where: { id: deposito.id } });
  });
}

export interface CambiarEstadoArgs {
  companyId: string;
  depositoId: string;
  estado: (typeof ESTADOS_DESTINO)[number];
  /** Fecha del hecho (aplicación o devolución); default ahora. */
  fecha?: Date | null;
  ahora?: Date;
}

export async function cambiarEstadoDeposito(db: PrismaClient, args: CambiarEstadoArgs) {
  const ahora = args.ahora ?? new Date();
  const fecha = args.fecha ?? ahora;
  if (Number.isNaN(fecha.getTime())) throw new HospitalError(400, "Fecha inválida");

  return db.$transaction(async (tx) => {
    const dep = await tx.hospDeposito.findUnique({ where: { id: args.depositoId }, include: { episodio: { select: { folio: true } } } });
    if (!dep || dep.companyId !== args.companyId) throw new HospitalError(404, "Depósito no encontrado");
    if (!TRANSICIONES_DEPOSITO[dep.estado].includes(args.estado)) {
      throw new HospitalError(409, `El depósito está ${dep.estado}; de ahí no pasa a ${args.estado}`);
    }
    if (fecha.getTime() < dep.fecha.getTime()) throw new HospitalError(400, "La fecha no puede ser anterior a la del depósito");

    const actualizado = await tx.hospDeposito.update({
      where: { id: dep.id },
      data: {
        estado: args.estado,
        ...(args.estado === "APLICADO" ? { aplicadoAt: fecha } : {}),
        ...(args.estado === "DEVUELTO" ? { devueltoAt: fecha } : {}),
      },
    });
    // ── Contabilidad (P3c): la etapa nueva (y el recibido, si no había llegado al libro) ──
    await asentarDeposito(tx, { ...actualizado, folio: dep.episodio.folio }, { ahora: fecha });
    return tx.hospDeposito.findUniqueOrThrow({ where: { id: dep.id } });
  });
}
