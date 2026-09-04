// ─────────────────────────────────────────────────────────────────────────────
// Aplicar un insumo a un paciente: «lo aplicado sale con su lote».
//
// Una sola transacción deja tres huellas amarradas entre sí:
//   1. HospMovimientoInsumo SALIDA_APLICACION (kardex, cantidad negativa) y
//      el lote con menos existencia,
//   2. HospCargo FARMACIA en la cuenta del episodio (precio de venta del
//      insumo o, si no tiene, el costo del lote), ligado al lote,
//   3. HospNota MEDICAMENTO_APLICADO en el expediente, ligada al cargo.
// Así la conciliación expediente ↔ cuenta (lámina 17) sale sola: el cargo
// tiene nota y la nota tiene cargo.
//
// FEFO: sin `loteId` se toma el lote que caduca primero con existencia; los
// sin caducidad al final. v1 NO parte una aplicación entre lotes: si el lote
// no cubre la cantidad, 409 y que el piso aplique en dos movimientos.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { esActivo, r2 } from "./util";

export interface AplicarInsumoArgs {
  companyId: string;
  episodioId: string;
  insumoId: string;
  loteId?: string | null;
  cantidad: number;
  usuarioId?: string | null;
  usuarioNombre: string;
  nota?: string | null;
  fecha?: Date;
  medicoId?: string | null;
}

const formatearCantidad = (n: number) => (Number.isInteger(n) ? String(n) : String(r2(n)));

export async function aplicarInsumo(db: PrismaClient, args: AplicarInsumoArgs) {
  const cantidad = Number(args.cantidad);
  if (!(cantidad > 0)) throw new HospitalError(400, "La cantidad debe ser mayor que cero");
  const fecha = args.fecha ?? new Date();

  return db.$transaction(async (tx) => {
    const [episodio, insumo] = await Promise.all([
      tx.hospEpisodio.findUnique({ where: { id: args.episodioId }, select: { id: true, companyId: true, estado: true, folio: true } }),
      tx.hospInsumo.findUnique({
        where: { id: args.insumoId },
        select: { id: true, companyId: true, nombre: true, unidad: true, categoria: true, precioVenta: true, ivaTasa: true, activo: true },
      }),
    ]);
    if (!episodio || episodio.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
    if (!esActivo(episodio.estado)) {
      throw new HospitalError(409, `El episodio ${episodio.folio} está ${episodio.estado === "ALTA" ? "dado de alta" : "cancelado"}: no se aplican insumos`);
    }
    if (!insumo || insumo.companyId !== args.companyId) throw new HospitalError(404, "Insumo no encontrado");
    if (!insumo.activo) throw new HospitalError(409, `El insumo ${insumo.nombre} está dado de baja`);

    // El lote: el indicado, o el primero en caducar (FEFO) con existencia.
    const lote = args.loteId
      ? await tx.hospLote.findUnique({ where: { id: args.loteId } })
      : await tx.hospLote.findFirst({
          where: { insumoId: insumo.id, existencia: { gt: 0 } },
          orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }, { recibidoAt: "asc" }],
        });
    if (!lote || lote.insumoId !== insumo.id || lote.companyId !== args.companyId) {
      throw new HospitalError(
        args.loteId ? 404 : 409,
        args.loteId ? "Lote no encontrado para ese insumo" : `${insumo.nombre}: sin existencia en farmacia`
      );
    }
    const existencia = Number(lote.existencia);
    if (existencia < cantidad) {
      throw new HospitalError(
        409,
        `El lote ${lote.lote} de ${insumo.nombre} sólo tiene ${formatearCantidad(existencia)} ${insumo.unidad}; ` +
          `una aplicación no se parte entre lotes — aplica ${formatearCantidad(existencia)} y el resto de otro lote`
      );
    }

    // Descuento atómico: si otra aplicación se adelantó y ya no alcanza, el
    // WHERE no coincide y no se descuenta de más.
    const descontado = await tx.hospLote.updateMany({
      where: { id: lote.id, existencia: { gte: cantidad } },
      data: { existencia: { decrement: cantidad } },
    });
    if (descontado.count !== 1) {
      throw new HospitalError(409, `El lote ${lote.lote} ya no tiene existencia suficiente (otra aplicación se adelantó)`);
    }

    const costoUnitario = Number(lote.costoUnitario);
    const precioUnitario = r2(Number(insumo.precioVenta ?? costoUnitario));
    const categoria = insumo.categoria === "MEDICAMENTO" || insumo.categoria === "SOLUCION" ? "FARMACIA" : "MATERIAL";
    const etiqueta = `${insumo.nombre} · lote ${lote.lote} · ${formatearCantidad(cantidad)} ${insumo.unidad}`;

    const cargo = await tx.hospCargo.create({
      data: {
        companyId: args.companyId,
        episodioId: episodio.id,
        fecha,
        categoria,
        descripcion: etiqueta,
        cantidad,
        precioUnitario,
        ivaTasa: insumo.ivaTasa == null ? null : Number(insumo.ivaTasa),
        importe: r2(cantidad * precioUnitario),
        origen: "FARMACIA",
        loteId: lote.id,
        medicoId: args.medicoId ?? null,
        creadoPorUserId: args.usuarioId ?? null,
      },
    });

    const movimiento = await tx.hospMovimientoInsumo.create({
      data: {
        companyId: args.companyId,
        insumoId: insumo.id,
        loteId: lote.id,
        tipo: "SALIDA_APLICACION",
        cantidad: -cantidad,
        costoUnitario,
        fecha,
        episodioId: episodio.id,
        cargoId: cargo.id,
        usuarioId: args.usuarioId ?? null,
        usuarioNombre: args.usuarioNombre,
      },
    });

    const texto =
      `${etiqueta} — descontado de farmacia y cargado a la cuenta.` + (args.nota?.trim() ? ` ${args.nota.trim()}` : "");
    const nota = await tx.hospNota.create({
      data: {
        episodioId: episodio.id,
        tipo: "MEDICAMENTO_APLICADO",
        fecha,
        texto,
        autorUserId: args.usuarioId ?? null,
        autorNombre: args.usuarioNombre,
        medicoId: args.medicoId ?? null,
        cargoId: cargo.id,
      },
    });

    const loteActualizado = await tx.hospLote.findUniqueOrThrow({ where: { id: lote.id } });
    return { cargo, movimiento, nota, lote: loteActualizado };
  });
}
