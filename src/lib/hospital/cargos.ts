// ─────────────────────────────────────────────────────────────────────────────
// Cancelar un cargo de la cuenta. Nunca se borra: queda `cancelado` con su
// motivo, y si el cargo nació de una aplicación de farmacia el lote recupera
// la existencia con un movimiento DEVOLUCION (el kardex también es historia).
// Un cargo que ya está en un CFDI no se toca: primero se cancela la factura.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { asentarMovimientoKardex } from "./asientos";
import { HospitalError } from "./errores";
import { r2 } from "./util";

export interface UsuarioAccion {
  id?: string | null;
  nombre: string;
}

/** El cargo con su salida de farmacia, si se puede tocar (ni facturado, ni en prefactura pendiente, ni cancelado). */
async function cargoModificable(tx: Prisma.TransactionClient, cargoId: string) {
  const cargo = await tx.hospCargo.findUnique({
    where: { id: cargoId },
    include: {
      movimientoInsumo: { select: { id: true, insumoId: true, loteId: true, cantidad: true, costoUnitario: true, asientoAt: true } },
      invoice: { select: { status: true } },
    },
  });
  if (!cargo) throw new HospitalError(404, "Cargo no encontrado");
  // Un CFDI ya cancelado no ampara el cargo: se puede cancelar.
  if (cargo.invoiceId && cargo.invoice?.status !== "CANCELLED") {
    throw new HospitalError(409, "El cargo ya está en una factura: cancela primero el CFDI");
  }
  if (cargo.cancelado) throw new HospitalError(409, "El cargo ya estaba cancelado");
  if (cargo.prefacturaId) {
    const pre = await tx.facturaBorrador.findUnique({ where: { id: cargo.prefacturaId }, select: { status: true } });
    if (pre?.status === "PENDIENTE") {
      throw new HospitalError(409, "El cargo está en una prefactura pendiente: descártala primero y vuelve a generarla sin él");
    }
  }
  return cargo;
}

type CargoModificable = Awaited<ReturnType<typeof cargoModificable>>;

/** Regresa `cantidad` al lote del que salió el cargo: movimiento DEVOLUCION, existencia y su asiento. */
async function devolverAlLote(
  tx: Prisma.TransactionClient,
  cargo: CargoModificable,
  cantidad: number,
  referencia: string,
  usuario: UsuarioAccion | null | undefined,
  fecha: Date
) {
  const mov = cargo.movimientoInsumo!;
  const dev = await tx.hospMovimientoInsumo.create({
    data: {
      companyId: cargo.companyId,
      insumoId: mov.insumoId,
      loteId: mov.loteId,
      tipo: "DEVOLUCION",
      cantidad,
      costoUnitario: mov.costoUnitario,
      fecha,
      episodioId: cargo.episodioId,
      referencia,
      usuarioId: usuario?.id ?? null,
      usuarioNombre: usuario?.nombre ?? null,
    },
  });
  await tx.hospLote.update({ where: { id: mov.loteId! }, data: { existencia: { increment: cantidad } } });
  // Contabilidad: si la aplicación llegó al libro, la devolución la reversa
  // (inventario de vuelta, costo fuera). No-op con la contabilidad apagada.
  await asentarMovimientoKardex(tx, {
    ...dev,
    descripcion: `devolución del cargo ${cargo.id}`,
    cargo: { ivaContexto: cargo.ivaContexto, ivaTasa: cargo.ivaTasa == null ? null : Number(cargo.ivaTasa) },
    origenAsentado: !!mov.asientoAt,
  });
  return { id: dev.id, cantidad };
}

/** La partida cotizada que el cargo surtía vuelve a quedar por surtir. */
async function reabrirPartida(tx: Prisma.TransactionClient, cargo: { id: string; cotizacionPartidaId: string | null }) {
  if (cargo.cotizacionPartidaId) {
    await tx.hospCotizacionPartida.update({ where: { id: cargo.cotizacionPartidaId }, data: { surtidaAt: null, surtidaPor: null } });
  }
  // Cargada sin inventario (una partida → un cargo): se libera completa.
  await tx.hospCotizacionPartida.updateMany({ where: { cargoId: cargo.id }, data: { cargoId: null, surtidaAt: null, surtidaPor: null } });
}

export async function cancelarCargo(
  tx: Prisma.TransactionClient,
  cargoId: string,
  args: { motivo: string; usuario?: UsuarioAccion | null; fecha?: Date }
) {
  const cargo = await cargoModificable(tx, cargoId);

  const fecha = args.fecha ?? new Date();
  const actualizado = await tx.hospCargo.update({
    where: { id: cargoId },
    data: { cancelado: true, canceladoAt: fecha, motivoCancelacion: args.motivo },
  });
  await reabrirPartida(tx, cargo);

  // Regresa el insumo al lote del que salió: la aplicación se registró con
  // signo negativo, la devolución lo compensa y el lote vuelve a tener la pieza.
  // Si el cargo ya se había reducido, sólo regresa lo que sigue cargado.
  let devolucion: { id: string; cantidad: number } | null = null;
  const mov = cargo.movimientoInsumo;
  if (mov && mov.loteId) {
    const cantidad = Math.min(Math.abs(Number(mov.cantidad)), Number(cargo.cantidad));
    devolucion = await devolverAlLote(tx, cargo, cantidad, `Cancelación del cargo ${cargo.id}: ${args.motivo}`, args.usuario, fecha);
  }

  return { cargo: actualizado, devolucion };
}

/**
 * Devolución PARCIAL de farmacia: el cargo baja a `cantidad` y la diferencia
 * regresa al MISMO lote. Nunca se devuelve más de lo que salió con ese cargo:
 * no hay forma de meter existencia a mano por aquí. A cero = cancelar.
 */
export async function reducirCargo(
  tx: Prisma.TransactionClient,
  cargoId: string,
  args: { cantidad: number; motivo: string; usuario?: UsuarioAccion | null; fecha?: Date }
) {
  const cargo = await cargoModificable(tx, cargoId);
  const mov = cargo.movimientoInsumo;
  if (!mov || !mov.loteId) throw new HospitalError(400, "Sólo se devuelve lo que farmacia surtió con lote");
  const actual = Number(cargo.cantidad);
  const nueva = r2(Number(args.cantidad));
  if (!(nueva > 0)) throw new HospitalError(400, "Para devolver todo, cancela el cargo");
  if (nueva >= actual) throw new HospitalError(400, `La nueva cantidad debe ser menor que ${actual}`);
  const fecha = args.fecha ?? new Date();
  const diferencia = r2(actual - nueva);
  const actualizado = await tx.hospCargo.update({
    where: { id: cargoId },
    data: { cantidad: nueva, importe: r2(nueva * Number(cargo.precioUnitario)) },
  });
  await reabrirPartida(tx, { id: cargo.id, cotizacionPartidaId: cargo.cotizacionPartidaId });
  const devolucion = await devolverAlLote(tx, cargo, diferencia, `Devolución parcial del cargo ${cargo.id}: ${args.motivo}`, args.usuario, fecha);
  return { cargo: actualizado, devolucion };
}
