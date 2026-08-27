// ─────────────────────────────────────────────────────────────────────────────
// Núcleo de la VENTA de una unidad — compartido por POST /vehiculos/[id]/vender
// y por POST /pedidos/[id]/facturar (una sola fuente de verdad del asiento):
//   1. ISAN (unidades NUEVO): tarifa Art. 3-I + exenciones Art. 8-II.
//   2. IVA 16% sobre precio + ISAN (Art. 12 LIVA).
//   3. Pólizas: ingreso (CxC / ingresos / IVA / ISAN) + costo de ventas por el
//      costo capitalizado real (el interés de piso ya se fue a gasto).
//   4. Comisión: monto explícito, o la regla de AutomotrizConfig.
// Sin auth: el llamador autoriza (writer + módulo) ANTES de invocar.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { postVehiculoVendido } from "@/lib/accounting/postings";
import { calcularIsan } from "@/lib/fiscal/isan";

const IVA_TASA = 0.16;

export class VentaError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export interface EjecutarVentaArgs {
  vehiculoId: string;
  precioVenta: number; // sin IVA, sin disminuir descuentos (base ISAN, Art. 2 LFISAN)
  fecha: Date;
  clienteId?: string | null;
  vendedorId?: string | null;
  /** Monto explícito; null/undefined aplica la regla de AutomotrizConfig. */
  comisionMonto?: number | null;
}

export async function ejecutarVentaUnidad(args: EjecutarVentaArgs) {
  const vehiculo = await prisma.vehiculo.findUnique({
    where: { id: args.vehiculoId },
    include: { costos: { select: { tipo: true, monto: true } } },
  });
  if (!vehiculo) throw new VentaError(404, "Unidad no encontrada");

  if (vehiculo.estado !== "DISPONIBLE" && vehiculo.estado !== "APARTADO") {
    throw new VentaError(
      422,
      `Sólo se venden unidades DISPONIBLES o APARTADAS (estado actual: ${vehiculo.estado})`
    );
  }

  // ISAN sólo en unidades nuevas (Art. 1 LFISAN); seminuevos no lo causan.
  const isanResultado =
    vehiculo.tipo === "NUEVO"
      ? calcularIsan(args.precioVenta, args.fecha.getUTCFullYear())
      : {
          base: args.precioVenta,
          impuestoTarifa: 0,
          reduccionLujo: 0,
          exencion: null,
          isan: 0,
          advertencias: [] as string[],
        };

  const iva = Math.round((args.precioVenta + isanResultado.isan) * IVA_TASA * 100) / 100;

  // Costo capitalizado real: compra + costos que entraron a 1115. El interés
  // de plan piso ya se fue a gasto (5205) — no sale del inventario, pero sí
  // resta en la utilidad por VIN.
  const costoCapitalizado =
    Number(vehiculo.costoCompra) +
    vehiculo.costos.filter((c) => c.tipo !== "INTERES_PISO").reduce((s, c) => s + Number(c.monto), 0);

  // Comisión: el monto explícito gana; si no viene, la regla de la empresa
  // (fija + % de la utilidad estimada). Sin regla → 0.
  let comisionMonto = args.comisionMonto ?? 0;
  if (args.comisionMonto == null) {
    const config = await prisma.automotrizConfig.findUnique({
      where: { companyId: vehiculo.companyId },
      select: { comisionPorcentajeUtilidad: true, comisionFija: true },
    });
    if (config) {
      const utilidadEstimada = Math.max(0, args.precioVenta - costoCapitalizado);
      comisionMonto =
        Math.round(
          (Number(config.comisionFija ?? 0) + (config.comisionPorcentajeUtilidad ?? 0) * utilidadEstimada) * 100
        ) / 100;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await postVehiculoVendido(tx, {
      companyId: vehiculo.companyId,
      vehiculoId: vehiculo.id,
      vin: vehiculo.vin,
      precio: args.precioVenta,
      iva,
      isan: isanResultado.isan,
      costoInventario: costoCapitalizado,
      fecha: args.fecha,
    });
    return tx.vehiculo.update({
      where: { id: vehiculo.id },
      data: {
        estado: "VENDIDO",
        precioVenta: args.precioVenta,
        isan: isanResultado.isan,
        fechaVenta: args.fecha,
        clienteId: args.clienteId ?? vehiculo.clienteId,
        vendedorId: args.vendedorId ?? vehiculo.vendedorId,
        comisionMonto,
      },
    });
  });

  return {
    vehiculo: updated,
    desglose: {
      precio: args.precioVenta,
      isan: isanResultado.isan,
      isanImpuestoTarifa: isanResultado.impuestoTarifa,
      isanReduccionLujo: isanResultado.reduccionLujo,
      exencionIsan: isanResultado.exencion,
      iva,
      total: args.precioVenta + isanResultado.isan + iva,
      costoCapitalizado,
      comision: comisionMonto,
    },
    advertencias: isanResultado.advertencias,
  };
}
