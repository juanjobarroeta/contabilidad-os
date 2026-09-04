// ─────────────────────────────────────────────────────────────────────────────
// Cancelar un cargo de la cuenta. Nunca se borra: queda `cancelado` con su
// motivo, y si el cargo nació de una aplicación de farmacia el lote recupera
// la existencia con un movimiento DEVOLUCION (el kardex también es historia).
// Un cargo que ya está en un CFDI no se toca: primero se cancela la factura.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { HospitalError } from "./errores";

export interface UsuarioAccion {
  id?: string | null;
  nombre: string;
}

export async function cancelarCargo(
  tx: Prisma.TransactionClient,
  cargoId: string,
  args: { motivo: string; usuario?: UsuarioAccion | null; fecha?: Date }
) {
  const cargo = await tx.hospCargo.findUnique({
    where: { id: cargoId },
    include: { movimientoInsumo: { select: { id: true, insumoId: true, loteId: true, cantidad: true, costoUnitario: true } } },
  });
  if (!cargo) throw new HospitalError(404, "Cargo no encontrado");
  if (cargo.invoiceId) {
    throw new HospitalError(409, "El cargo ya está en una factura: cancela primero el CFDI");
  }
  if (cargo.cancelado) throw new HospitalError(409, "El cargo ya estaba cancelado");

  const fecha = args.fecha ?? new Date();
  const actualizado = await tx.hospCargo.update({
    where: { id: cargoId },
    data: { cancelado: true, canceladoAt: fecha, motivoCancelacion: args.motivo },
  });

  // Regresa el insumo al lote del que salió: la aplicación se registró con
  // signo negativo, la devolución lo compensa y el lote vuelve a tener la pieza.
  let devolucion: { id: string; cantidad: number } | null = null;
  const mov = cargo.movimientoInsumo;
  if (mov && mov.loteId) {
    const cantidad = Math.abs(Number(mov.cantidad));
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
        referencia: `Cancelación del cargo ${cargo.id}: ${args.motivo}`,
        usuarioId: args.usuario?.id ?? null,
        usuarioNombre: args.usuario?.nombre ?? null,
      },
    });
    await tx.hospLote.update({ where: { id: mov.loteId }, data: { existencia: { increment: cantidad } } });
    devolucion = { id: dev.id, cantidad };
  }

  return { cargo: actualizado, devolucion };
}
