// ─────────────────────────────────────────────────────────────────────────────
// Las compras de un insumo, para su ficha (farmacia y compras):
//   · entradas por compra: cuándo llegó, quién la capturó, lote, costo,
//     proveedor, CFDI y la requisición/orden que la amparó (quién la pidió y
//     quién la autorizó);
//   · lo que viene en camino: líneas de órdenes autorizadas sin recibir;
//   · historial de precios: costos de entrada y cotizaciones recibidas;
//   · resumen por proveedor: cuántas veces, cuánto, último y mejor costo.
// Sólo lectura.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { ORIGEN_HOSPITAL } from "./requisiciones";
import { nombresDeUsuarios } from "./requisiciones-http";

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function comprasDeInsumo(db: Db, companyId: string, insumoId: string) {
  const [entradas, partidas] = await Promise.all([
    db.hospMovimientoInsumo.findMany({
      where: { companyId, insumoId, tipo: "ENTRADA_COMPRA" },
      orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true, fecha: true, createdAt: true, cantidad: true, costoUnitario: true, usuarioNombre: true, referencia: true,
        lote: { select: { lote: true, caducidad: true, supplier: { select: { id: true, razonSocial: true, rfc: true } } } },
        invoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, contraparteNombre: true, contraparteRfc: true } },
        solicitudPartida: {
          select: {
            solicitud: { select: { id: true, folio: true, creadaPorId: true, createdAt: true, aprobadaPorId: true, aprobadaAt: true, area: true } },
            cotizacionGanadora: { select: { supplierId: true, supplierNombre: true } },
          },
        },
      },
    }),
    // Líneas de requisición con este insumo (pedidas, autorizadas o no) y sus cotizaciones.
    db.solicitudPartida.findMany({
      where: { hospInsumoId: insumoId, solicitud: { companyId, origen: ORIGEN_HOSPITAL, estado: { in: ["PENDIENTE", "APROBADA", "PAGADA", "RECHAZADA"] } } },
      select: {
        id: true, cantidad: true, cantidadRecibida: true, precioUnitario: true, unidad: true,
        solicitud: { select: { id: true, folio: true, estado: true, createdAt: true, aprobadaAt: true, aprobadaPorId: true, creadaPorId: true, area: true } },
        cotizacionGanadora: { select: { id: true, supplierId: true, supplierNombre: true } },
        cotizaciones: { select: { precioUnitario: true, cotizacion: { select: { id: true, supplierId: true, supplierNombre: true, fechaCotizacion: true, createdAt: true } } } },
      },
      orderBy: { solicitud: { createdAt: "desc" } },
      take: 200,
    }),
  ]);

  const nombres = await nombresDeUsuarios([
    ...entradas.flatMap((e) => [e.solicitudPartida?.solicitud.creadaPorId, e.solicitudPartida?.solicitud.aprobadaPorId]),
    ...partidas.flatMap((p) => [p.solicitud.creadaPorId, p.solicitud.aprobadaPorId]),
  ]);
  const quien = (id: string | null | undefined) => (id ? nombres[id] ?? null : null);

  const listaEntradas = entradas.map((e) => {
    const sol = e.solicitudPartida?.solicitud ?? null;
    const proveedor =
      e.lote?.supplier ??
      (e.solicitudPartida?.cotizacionGanadora ? { id: e.solicitudPartida.cotizacionGanadora.supplierId, razonSocial: e.solicitudPartida.cotizacionGanadora.supplierNombre, rfc: null } : null) ??
      (e.invoice?.contraparteNombre ? { id: null, razonSocial: e.invoice.contraparteNombre, rfc: e.invoice.contraparteRfc } : null);
    return {
      id: e.id,
      fecha: e.fecha,
      capturadaAt: e.createdAt,
      capturo: e.usuarioNombre,
      cantidad: Number(e.cantidad),
      costoUnitario: e.costoUnitario == null ? null : Number(e.costoUnitario),
      lote: e.lote ? { lote: e.lote.lote, caducidad: e.lote.caducidad } : null,
      proveedor,
      cfdi: e.invoice ? { id: e.invoice.id, uuid: e.invoice.uuid, serie: e.invoice.serie, folio: e.invoice.folio, fecha: e.invoice.fecha, total: Number(e.invoice.total) } : null,
      requisicion: sol
        ? { id: sol.id, folio: sol.folio, area: sol.area, pidio: quien(sol.creadaPorId), pedidaAt: sol.createdAt, autorizo: quien(sol.aprobadaPorId), autorizadaAt: sol.aprobadaAt }
        : null,
      referencia: e.referencia,
    };
  });

  const enCamino = partidas
    .filter((p) => (p.solicitud.estado === "APROBADA" || p.solicitud.estado === "PENDIENTE") && Number(p.cantidad) - Number(p.cantidadRecibida) > 1e-6)
    .map((p) => ({
      partidaId: p.id,
      requisicion: { id: p.solicitud.id, folio: p.solicitud.folio, estado: p.solicitud.estado, pedidaAt: p.solicitud.createdAt, pidio: quien(p.solicitud.creadaPorId), autorizo: quien(p.solicitud.aprobadaPorId), autorizadaAt: p.solicitud.aprobadaAt },
      proveedor: p.cotizacionGanadora ? { id: p.cotizacionGanadora.supplierId, razonSocial: p.cotizacionGanadora.supplierNombre } : null,
      cantidad: Number(p.cantidad),
      recibida: Number(p.cantidadRecibida),
      precioUnitario: Number(p.precioUnitario),
      unidad: p.unidad,
    }));

  // Historial de precios: lo que costó al entrar y lo que cotizaron los proveedores.
  const precios = [
    ...listaEntradas
      .filter((e) => e.costoUnitario != null)
      .map((e) => ({ fecha: e.fecha, origen: "ENTRADA" as const, proveedor: e.proveedor?.razonSocial ?? null, precio: e.costoUnitario as number, folio: e.requisicion?.folio ?? e.cfdi?.folio ?? null, gano: null as boolean | null })),
    ...partidas.flatMap((p) =>
      p.cotizaciones.map((c) => ({
        fecha: c.cotizacion.fechaCotizacion ?? c.cotizacion.createdAt,
        origen: "COTIZACION" as const,
        proveedor: c.cotizacion.supplierNombre,
        precio: Number(c.precioUnitario),
        folio: p.solicitud.folio,
        gano: p.cotizacionGanadora?.id === c.cotizacion.id,
      }))
    ),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

  // Resumen por proveedor (de las entradas por compra).
  const porProveedor = new Map<string, { proveedor: string; rfc: string | null; compras: number; cantidad: number; monto: number; ultimoCosto: number | null; ultimaFecha: Date | null; mejorCosto: number | null }>();
  for (const e of listaEntradas) {
    const k = e.proveedor?.razonSocial ?? "Sin proveedor";
    const g = porProveedor.get(k) ?? { proveedor: k, rfc: e.proveedor?.rfc ?? null, compras: 0, cantidad: 0, monto: 0, ultimoCosto: null, ultimaFecha: null, mejorCosto: null };
    g.compras++;
    g.cantidad = r2(g.cantidad + e.cantidad);
    if (e.costoUnitario != null) {
      g.monto = r2(g.monto + e.cantidad * e.costoUnitario);
      if (!g.ultimaFecha || new Date(e.fecha) > g.ultimaFecha) { g.ultimaFecha = new Date(e.fecha); g.ultimoCosto = e.costoUnitario; }
      g.mejorCosto = g.mejorCosto == null ? e.costoUnitario : Math.min(g.mejorCosto, e.costoUnitario);
    }
    porProveedor.set(k, g);
  }

  return {
    entradas: listaEntradas,
    enCamino,
    precios: precios.slice(0, 100),
    porProveedor: [...porProveedor.values()].sort((a, b) => b.monto - a.monto),
  };
}
