// ─────────────────────────────────────────────────────────────────────────────
// Derivación de inventario de vehículos desde un CFDI (onboarding con la e.firma).
//
// El edge del producto, igual que auto-activo: "solo corre". Al sincronizar los
// CFDIs del SAT, cada factura que ampara un vehículo (complemento VentaVehiculos)
// construye/actualiza el inventario sin que nadie capture nada:
//   • COMPRA (EGRESO, la agencia es receptor) → crea la unidad DISPONIBLE con su
//     costo, liga el CFDI de compra y registra traslado/seguro como VehiculoCosto.
//   • VENTA  (INGRESO, la agencia es emisor)   → marca la unidad VENDIDO, liga el
//     CFDI de venta y su precio. Si la venta llega antes que la compra, crea la
//     unidad ya VENDIDA para no perderla (la compra posterior la enriquece).
//
// IMPORTANTE — no postea al mayor. El asiento contable del CFDI lo genera el
// cierre mensual (lib/contabilidad/posting.ts); este derivador SOLO construye la
// capa de inventario (Vehiculo / VehiculoCosto). Postear aquí duplicaría.
//
// Idempotente: por (companyId, vin) para la unidad, y por (vehiculoId, invoiceId)
// para los costos. Seguro de llamar siempre — mismo contrato que auto-activo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  datosGeneralesDesdeCfdi,
  extraerDatosVehiculoCfdi,
  marcaDesdeTexto,
  tipoCostoDesdeConcepto,
} from "./vin";
import { modeloLimpio } from "./claves";

type Db = PrismaClient | Prisma.TransactionClient;

export interface DerivarVehiculoArgs {
  companyId: string;
  invoiceId: string;
  /** Invoice.tipo — INGRESO = venta (agencia emite), EGRESO = compra (agencia recibe). */
  tipo: string;
  fecha: Date;
  rawXml: string | null;
  /** Proveedor canónico (emisor) en una compra, si el import ya lo resolvió. */
  supplierId?: string | null;
  /** Cliente canónico (receptor) en una venta, si el import ya lo resolvió. */
  clienteId?: string | null;
}

export interface DerivarVehiculoResultado {
  creados: number;
  actualizados: number;
  vins: string[];
}

/**
 * marca/modelo/versión/año para una unidad nueva: primero el catálogo de claves
 * vehiculares (Anexo 15 — autoritativo) vía la clave del complemento; si la
 * clave aún no está ingerida, la heurística de texto. En ambos casos la unidad
 * nace `autoCreado` y el distribuidor confirma.
 */
async function generalesParaUnidad(
  db: Db,
  v: { claveVehicular: string | null; descripcion: string | null; noIdentificacion: string | null },
  anioFallback: number
): Promise<{ marca: string; modelo: string; version: string | null; anio: number }> {
  const heur = datosGeneralesDesdeCfdi(v.descripcion, v.noIdentificacion, anioFallback);

  if (v.claveVehicular) {
    const cat = await db.claveVehicularCatalogo.findUnique({
      where: { clave: v.claveVehicular },
      select: { empresa: true, modelo: true, version: true },
    });
    if (cat) {
      return {
        marca:
          marcaDesdeTexto(`${cat.modelo} ${cat.version ?? ""}`) ??
          marcaDesdeTexto(cat.empresa) ??
          heur.marca ??
          cat.empresa.slice(0, 60),
        modelo: modeloLimpio(cat.modelo).slice(0, 60) || heur.modelo || "POR REVISAR",
        version: cat.version ? cat.version.slice(0, 80) : null,
        anio: heur.anio ?? anioFallback,
      };
    }
  }

  return {
    marca: heur.marca ?? "POR REVISAR",
    modelo: heur.modelo ?? "POR REVISAR",
    version: null,
    anio: heur.anio ?? anioFallback,
  };
}

/**
 * Deriva/actualiza el inventario de una factura. Devuelve null si el CFDI no
 * ampara vehículos o no hay rawXml para parsear.
 */
export async function derivarVehiculoDesdeCfdiSiAplica(
  db: Db,
  args: DerivarVehiculoArgs
): Promise<DerivarVehiculoResultado | null> {
  if (!args.rawXml) return null;

  const datos = extraerDatosVehiculoCfdi(args.rawXml);
  if (datos.vehiculos.length === 0) return null;

  const esVenta = args.tipo === "INGRESO";
  const esCompra = args.tipo === "EGRESO";
  // Sólo compra/venta mueven inventario. TRASLADO/NOMINA/PAGO no aplican.
  if (!esVenta && !esCompra) return null;

  const anioFallback = args.fecha.getUTCFullYear();
  let creados = 0;
  let actualizados = 0;
  const vins: string[] = [];

  for (const v of datos.vehiculos) {
    vins.push(v.niv);
    const existente = await db.vehiculo.findUnique({
      where: { companyId_vin: { companyId: args.companyId, vin: v.niv } },
      select: {
        id: true,
        estado: true,
        compraInvoiceId: true,
        ventaInvoiceId: true,
        supplierId: true,
        clienteId: true,
      },
    });

    if (esCompra) {
      if (existente) {
        // Idempotente: si ya tiene su CFDI de compra, no re-procesar. Pero si a
        // la primera pasada le faltó el proveedor (se resolvió después), una
        // re-corrida lo completa sin tocar nada más.
        if (existente.compraInvoiceId) {
          if (existente.compraInvoiceId === args.invoiceId && args.supplierId && !existente.supplierId) {
            await db.vehiculo.update({ where: { id: existente.id }, data: { supplierId: args.supplierId } });
            actualizados++;
          }
          continue;
        }
        await db.vehiculo.update({
          where: { id: existente.id },
          data: {
            compraInvoiceId: args.invoiceId,
            costoCompra: v.importe,
            fechaCompra: args.fecha,
            supplierId: args.supplierId ?? undefined,
            claveVehicular: v.claveVehicular ?? undefined,
            descripcionCfdi: v.descripcion ?? undefined,
          },
        });
        actualizados++;
        await registrarCostosCompra(db, existente.id, args, datos.otrosConceptos);
        continue;
      }
      const g = await generalesParaUnidad(db, v, anioFallback);
      const creado = await db.vehiculo.create({
        data: {
          companyId: args.companyId,
          vin: v.niv,
          marca: g.marca,
          modelo: g.modelo,
          version: g.version,
          anio: g.anio,
          tipo: "NUEVO",
          estado: "DISPONIBLE",
          costoCompra: v.importe,
          fechaCompra: args.fecha,
          compraInvoiceId: args.invoiceId,
          supplierId: args.supplierId ?? null,
          claveVehicular: v.claveVehicular ?? null,
          descripcionCfdi: v.descripcion ?? null,
          autoCreado: true,
        },
        select: { id: true },
      });
      creados++;
      await registrarCostosCompra(db, creado.id, args, datos.otrosConceptos);
      continue;
    }

    // esVenta
    if (existente) {
      // Idempotente; igual que en compra, una re-corrida completa el cliente si
      // al derivar la venta el CFDI aún no tenía Customer ligado.
      if (existente.ventaInvoiceId) {
        if (existente.ventaInvoiceId === args.invoiceId && args.clienteId && !existente.clienteId) {
          await db.vehiculo.update({ where: { id: existente.id }, data: { clienteId: args.clienteId } });
          actualizados++;
        }
        continue;
      }
      await db.vehiculo.update({
        where: { id: existente.id },
        data: {
          estado: "VENDIDO",
          precioVenta: v.importe,
          ventaInvoiceId: args.invoiceId,
          fechaVenta: args.fecha,
          clienteId: args.clienteId ?? undefined,
        },
      });
      actualizados++;
      continue;
    }
    // Venta sin compra previa: crea la unidad ya VENDIDA para no perderla.
    const g = await generalesParaUnidad(db, v, anioFallback);
    await db.vehiculo.create({
      data: {
        companyId: args.companyId,
        vin: v.niv,
        marca: g.marca,
        modelo: g.modelo,
        version: g.version,
        anio: g.anio,
        tipo: "NUEVO",
        estado: "VENDIDO",
        precioVenta: v.importe,
        ventaInvoiceId: args.invoiceId,
        fechaVenta: args.fecha,
        clienteId: args.clienteId ?? null,
        claveVehicular: v.claveVehicular ?? null,
        descripcionCfdi: v.descripcion ?? null,
        autoCreado: true,
      },
    });
    creados++;
  }

  return { creados, actualizados, vins };
}

/**
 * Registra traslado/seguro/accesorios de una factura de compra como
 * VehiculoCosto. Idempotente por (vehiculoId, invoiceId): si ya hay costos de
 * ese CFDI en la unidad, no duplica.
 */
async function registrarCostosCompra(
  db: Db,
  vehiculoId: string,
  args: DerivarVehiculoArgs,
  otros: ReturnType<typeof extraerDatosVehiculoCfdi>["otrosConceptos"]
): Promise<void> {
  if (otros.length === 0) return;
  const yaHay = await db.vehiculoCosto.findFirst({
    where: { vehiculoId, invoiceId: args.invoiceId },
    select: { id: true },
  });
  if (yaHay) return;

  await db.vehiculoCosto.createMany({
    data: otros
      .filter((c) => c.importe > 0)
      .map((c) => ({
        vehiculoId,
        tipo: tipoCostoDesdeConcepto(c.claveProdServ, c.descripcion),
        concepto: c.descripcion ?? "Costo de la unidad",
        monto: c.importe,
        fecha: args.fecha,
        invoiceId: args.invoiceId,
      })),
  });
}
