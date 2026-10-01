// ─────────────────────────────────────────────────────────────────────────────
// Compras del hospital con control: requisición → autorización → orden →
// recepción → CFDI → autorización de pago → tesorería.
//
// Motor: el de compras de obra (SolicitudCompra / SolicitudAdjudicacion /
// PagoProveedor / PagoAplicacion), con `origen = "HOSPITAL"`. Una requisición
// del hospital lleva UN proveedor (elegido o dado de alta al pedir), así que se
// guarda como una sola oferta ganadora en todas sus líneas: al autorizarla,
// `generateAdjudicaciones` produce una adjudicación = la ORDEN DE COMPRA, la
// unidad que se recibe, se factura, se autoriza y se paga.
//
// Controles (separación de funciones):
//   · Toda requisición requiere autorización (COMPRAS_AUTORIZAR) y nadie
//     autoriza la suya.
//   · Autorizar el pago (PAGOS_AUTORIZAR) lo hace alguien distinto de quien
//     pidió; registrar el pago (TESORERIA_PAGAR), alguien distinto de quien
//     lo autorizó. Los permisos los valida la ruta; aquí van las reglas.
//   · Registrar el pago NO toca bancos ni contabilidad: el movimiento real
//     llega con el estado de cuenta y se concilia en el hub (la factura queda
//     pagada con evidencia).
//
// Sin `import` de authz: estas reglas corren también en pruebas y scripts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateAdjudicaciones } from "@/lib/construccion/adjudicaciones";
import { aplicadoDeAdjudicacion, aplicarPago, recomputeAdjudicacionEstado, saldoDe } from "@/lib/construccion/pagos-proveedor";
import { conFolioUnico, siguienteFolio } from "./folio";
import { HospitalError } from "./errores";
import { amparadoDe, amparadoPorReps, conciliadoDe, pagadoPorEvidencia } from "./cobranza";

type Db = PrismaClient | Prisma.TransactionClient;

export const ORIGEN_HOSPITAL = "HOSPITAL";
export const VINCULO_ORDEN = "ADJUDICACION";

const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.01;
const DIA = 86_400_000;

export interface PartidaInput {
  hospInsumoId?: string | null;
  descripcion: string;
  unidad?: string | null;
  cantidad: number;
  precioUnitario: number;
}

export interface RequisicionInput {
  supplierId: string;
  area?: string | null;
  notas?: string | null;
  fechaEntrega?: Date | null;
  partidas: PartidaInput[];
}

// ── Requisición ─────────────────────────────────────────────────────────────

async function validarProveedorEInsumos(db: Db, companyId: string, input: RequisicionInput) {
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, companyId },
    select: { id: true, razonSocial: true, terms: { select: { tieneCredito: true, diasCredito: true } } },
  });
  if (!supplier) throw new HospitalError(404, "Proveedor no encontrado en esta empresa");
  const ids = [...new Set(input.partidas.map((p) => p.hospInsumoId).filter((x): x is string => !!x))];
  if (ids.length) {
    const n = await db.hospInsumo.count({ where: { companyId, id: { in: ids } } });
    if (n !== ids.length) throw new HospitalError(404, "Algún insumo no es de esta empresa");
  }
  return supplier;
}

/**
 * Líneas + la oferta única del proveedor, adjudicada completa. Devuelve el
 * total. La forma de pago y los días de crédito salen de las condiciones del
 * proveedor (SupplierTerms); sin ellas, contado.
 */
async function armarLineas(
  tx: Prisma.TransactionClient,
  solicitudId: string,
  supplier: { id: string; razonSocial: string; terms: { tieneCredito: boolean; diasCredito: number } | null },
  partidas: PartidaInput[]
): Promise<number> {
  const creadas: { id: string; cantidad: number; precio: number; importe: number }[] = [];
  for (const p of partidas) {
    const importe = r2(p.cantidad * p.precioUnitario);
    const row = await tx.solicitudPartida.create({
      data: {
        solicitudId,
        hospInsumoId: p.hospInsumoId ?? null,
        descripcion: p.descripcion.trim(),
        unidad: p.unidad?.trim() || null,
        cantidad: p.cantidad,
        precioUnitario: p.precioUnitario,
        importe,
      },
      select: { id: true },
    });
    creadas.push({ id: row.id, cantidad: p.cantidad, precio: p.precioUnitario, importe });
  }
  const total = r2(creadas.reduce((a, c) => a + c.importe, 0));
  const credito = supplier.terms?.tieneCredito ?? false;
  const cot = await tx.solicitudCompraCotizacion.create({
    data: {
      solicitudId,
      supplierId: supplier.id,
      supplierNombre: supplier.razonSocial,
      tieneCredito: credito,
      diasCredito: credito ? supplier.terms?.diasCredito ?? 0 : null,
      total,
      isSelected: true,
      partidas: {
        create: creadas.map((c) => ({ solicitudPartidaId: c.id, precioUnitario: c.precio, importe: c.importe })),
      },
    },
    select: { id: true },
  });
  await tx.solicitudPartida.updateMany({ where: { solicitudId }, data: { cotizacionGanadoraId: cot.id } });
  await tx.solicitudCompra.update({
    where: { id: solicitudId },
    data: { total, supplierId: supplier.id, formaPago: credito ? "CREDITO" : "CONTADO" },
  });
  return total;
}

export async function crearRequisicion(companyId: string, userId: string, input: RequisicionInput) {
  const supplier = await validarProveedorEInsumos(prisma, companyId, input);
  return conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "requisicion");
      const sol = await tx.solicitudCompra.create({
        data: {
          companyId,
          folio,
          origen: ORIGEN_HOSPITAL,
          area: input.area?.trim() || null,
          notas: input.notas?.trim() || null,
          fechaEntrega: input.fechaEntrega ?? null,
          estado: "PENDIENTE",
          creadaPorId: userId,
          total: 0,
        },
        select: { id: true, folio: true },
      });
      const total = await armarLineas(tx, sol.id, supplier, input.partidas);
      return { id: sol.id, folio: sol.folio, total };
    })
  );
}

async function cargarHospital(db: Db, id: string, companyId?: string) {
  const sol = await db.solicitudCompra.findUnique({
    where: { id },
    select: { id: true, companyId: true, folio: true, estado: true, origen: true, creadaPorId: true, total: true },
  });
  if (!sol || sol.origen !== ORIGEN_HOSPITAL || (companyId && sol.companyId !== companyId)) {
    throw new HospitalError(404, "Requisición no encontrada");
  }
  return sol;
}

export async function companyDeRequisicion(id: string): Promise<string> {
  return (await cargarHospital(prisma, id)).companyId;
}

/** Mientras no se autoriza (pendiente o rechazada) se reescribe completa y vuelve a «por autorizar». */
export async function editarRequisicion(id: string, companyId: string, input: RequisicionInput) {
  const sol = await cargarHospital(prisma, id, companyId);
  if (sol.estado !== "PENDIENTE" && sol.estado !== "RECHAZADA") {
    throw new HospitalError(409, "Sólo se edita una requisición por autorizar o rechazada");
  }
  const supplier = await validarProveedorEInsumos(prisma, companyId, input);
  return prisma.$transaction(async (tx) => {
    await tx.solicitudCotizacionPartida.deleteMany({ where: { cotizacion: { solicitudId: id } } });
    await tx.solicitudCompraCotizacion.deleteMany({ where: { solicitudId: id } });
    await tx.solicitudPartida.deleteMany({ where: { solicitudId: id } });
    await tx.solicitudCompra.update({
      where: { id },
      data: {
        area: input.area?.trim() || null,
        notas: input.notas?.trim() || null,
        fechaEntrega: input.fechaEntrega ?? null,
        estado: "PENDIENTE",
        rechazadaPorId: null,
        rechazadaAt: null,
        rechazoMotivo: null,
      },
    });
    const total = await armarLineas(tx, id, supplier, input.partidas);
    return { id, folio: sol.folio, total };
  });
}

export async function aprobarRequisicion(id: string, companyId: string, userId: string) {
  const sol = await cargarHospital(prisma, id, companyId);
  if (sol.estado !== "PENDIENTE") throw new HospitalError(409, `La requisición está ${sol.estado.toLowerCase()}: no se puede autorizar`);
  if (sol.creadaPorId === userId) throw new HospitalError(403, "No puedes autorizar tu propia requisición: la autoriza otra persona.");
  return prisma.$transaction(async (tx) => {
    // Condicionado al estado: dos autorizaciones simultáneas no duplican la orden.
    const n = await tx.solicitudCompra.updateMany({
      where: { id, estado: "PENDIENTE" },
      data: { estado: "APROBADA", aprobadaPorId: userId, aprobadaAt: new Date() },
    });
    if (n.count !== 1) throw new HospitalError(409, "La requisición cambió mientras se autorizaba");
    await generateAdjudicaciones(tx, id);
    const orden = await tx.solicitudAdjudicacion.findFirst({ where: { solicitudId: id }, select: { id: true } });
    return { id, folio: sol.folio, ordenId: orden?.id ?? null };
  });
}

export async function rechazarRequisicion(id: string, companyId: string, userId: string, motivo: string) {
  const sol = await cargarHospital(prisma, id, companyId);
  if (sol.estado !== "PENDIENTE") throw new HospitalError(409, "Sólo se rechaza una requisición por autorizar");
  if (sol.creadaPorId === userId) throw new HospitalError(403, "Tu propia requisición no la rechazas: edítala o cancélala.");
  await prisma.solicitudCompra.update({
    where: { id },
    data: { estado: "RECHAZADA", rechazadaPorId: userId, rechazadaAt: new Date(), rechazoMotivo: motivo.trim() },
  });
  return { id, folio: sol.folio };
}

/**
 * Cancelar: por autorizar o rechazada, siempre; autorizada, sólo si la orden
 * no tiene nada encima (ni recepción, ni CFDI, ni pagos). Nunca se borra: la
 * requisición queda como CANCELADA para la auditoría.
 */
export async function cancelarRequisicion(id: string, companyId: string) {
  const sol = await cargarHospital(prisma, id, companyId);
  if (sol.estado === "CANCELADA") return { id, folio: sol.folio };
  if (sol.estado === "PAGADA") throw new HospitalError(409, "Una requisición pagada no se cancela");
  if (sol.estado === "APROBADA") {
    const [recibido, adjs] = await Promise.all([
      prisma.solicitudPartida.aggregate({ where: { solicitudId: id }, _sum: { cantidadRecibida: true } }),
      prisma.solicitudAdjudicacion.findMany({ where: { solicitudId: id }, select: { id: true, aplicaciones: { select: { id: true } } } }),
    ]);
    if (Number(recibido._sum.cantidadRecibida ?? 0) > 0) throw new HospitalError(409, "La orden ya tiene mercancía recibida: no se cancela");
    if (adjs.some((a) => a.aplicaciones.length > 0)) throw new HospitalError(409, "La orden ya tiene pagos registrados: no se cancela");
    const vinculos = await prisma.construccionCfdiVinculo.count({
      where: { companyId, targetTipo: VINCULO_ORDEN, targetId: { in: adjs.map((a) => a.id) } },
    });
    if (vinculos > 0) throw new HospitalError(409, "La orden ya tiene su factura ligada: desvincúlala primero");
    await prisma.$transaction([
      prisma.solicitudAdjudicacion.deleteMany({ where: { solicitudId: id } }),
      prisma.solicitudCompra.update({ where: { id }, data: { estado: "CANCELADA" } }),
    ]);
    return { id, folio: sol.folio };
  }
  await prisma.solicitudCompra.update({ where: { id }, data: { estado: "CANCELADA" } });
  return { id, folio: sol.folio };
}

// ── Recepción ───────────────────────────────────────────────────────────────

/**
 * La línea de una orden autorizada del hospital, lista para recibir. La usan
 * la recepción manual (lo que no es insumo) y la de lotes de farmacia.
 */
export async function partidaRecibible(db: Db, partidaId: string, companyId: string) {
  const p = await db.solicitudPartida.findUnique({
    where: { id: partidaId },
    select: {
      id: true, cantidad: true, cantidadRecibida: true, hospInsumoId: true, descripcion: true,
      solicitud: { select: { id: true, companyId: true, estado: true, origen: true, folio: true, supplierId: true } },
    },
  });
  if (!p || p.solicitud.companyId !== companyId || p.solicitud.origen !== ORIGEN_HOSPITAL) {
    throw new HospitalError(404, "Línea de orden no encontrada");
  }
  if (p.solicitud.estado !== "APROBADA" && p.solicitud.estado !== "PAGADA") {
    throw new HospitalError(409, "Sólo se recibe contra una requisición autorizada");
  }
  return p;
}

/** Lo que falta por recibir; recibir de más no se acepta (lo extra es otra requisición). */
export function validarCantidadRecibida(p: { cantidad: unknown; cantidadRecibida: unknown }, cantidad: number) {
  const falta = r2(Number(p.cantidad) - Number(p.cantidadRecibida));
  if (cantidad > falta + 1e-6) {
    throw new HospitalError(409, `Sólo faltan ${falta} por recibir de esta línea: lo que llegó de más va en otra requisición`);
  }
}

/** Recepción de lo que NO es insumo de farmacia (servicios, equipo, papelería). */
export async function recibirManual(partidaId: string, companyId: string, cantidad: number) {
  const p = await partidaRecibible(prisma, partidaId, companyId);
  if (p.hospInsumoId) {
    throw new HospitalError(409, "Es un insumo de farmacia: se recibe con su lote en Farmacia (entra al inventario)");
  }
  validarCantidadRecibida(p, cantidad);
  // Condicionada a lo que falta: dos recepciones simultáneas no pasan de lo pedido.
  const n = await prisma.$executeRaw`UPDATE "SolicitudPartida" SET "cantidadRecibida" = "cantidadRecibida" + ${cantidad} WHERE id = ${partidaId} AND "cantidadRecibida" + ${cantidad} <= cantidad + 0.000001`;
  if (n !== 1) throw new HospitalError(409, "La línea ya no tiene esa cantidad por recibir");
  return { partidaId, recibida: r2(Number(p.cantidadRecibida) + cantidad), cantidad: Number(p.cantidad) };
}

// ── Órdenes (lectura) ───────────────────────────────────────────────────────

export type EtapaOrden =
  | "POR_RECIBIR"
  | "POR_FACTURAR"
  | "POR_AUTORIZAR_PAGO"
  | "EN_TESORERIA"
  | "PAGADA"
  | "CONCILIADA";

/** Base del vencimiento: la factura más vieja ligada; sin factura, la autorización. */
export function vencimientoDe(o: {
  aprobadaAt: Date | null;
  tieneCredito: boolean;
  diasCredito: number | null;
  fechasCfdi: Date[];
}): Date | null {
  const base = o.fechasCfdi.length ? new Date(Math.min(...o.fechasCfdi.map((f) => f.getTime()))) : o.aprobadaAt;
  if (!base) return null;
  const dias = o.tieneCredito ? o.diasCredito ?? 0 : 0;
  return new Date(base.getTime() + dias * DIA);
}

export function etapaDe(o: {
  saldo: number;
  total: number;
  recepcionCompleta: boolean;
  facturado: number;
  autorizada: boolean;
  conciliado: boolean;
}): EtapaOrden {
  if (o.saldo <= EPS && o.total > 0) return o.conciliado ? "CONCILIADA" : "PAGADA";
  if (o.autorizada) return "EN_TESORERIA";
  if (o.facturado <= EPS) return o.recepcionCompleta ? "POR_FACTURAR" : "POR_RECIBIR";
  return "POR_AUTORIZAR_PAGO";
}

export interface FiltroOrdenes {
  ordenId?: string;
  solicitudId?: string;
  soloAbiertas?: boolean;
  soloAutorizadas?: boolean;
}

/**
 * Las órdenes del hospital con todo lo que las pantallas leen: recepción,
 * facturas ligadas (y si el banco ya las pagó), vencimiento, pago y
 * autorización. Una consulta por colección, no por orden.
 */
export async function ordenesDeCompra(db: Db, companyId: string, filtro: FiltroOrdenes = {}, hoy = new Date()) {
  const adjs = await db.solicitudAdjudicacion.findMany({
    where: {
      companyId,
      solicitud: { origen: ORIGEN_HOSPITAL },
      ...(filtro.ordenId ? { id: filtro.ordenId } : {}),
      ...(filtro.solicitudId ? { solicitudId: filtro.solicitudId } : {}),
      ...(filtro.soloAbiertas ? { estado: { in: ["POR_PAGAR", "PARCIAL"] } } : {}),
      ...(filtro.soloAutorizadas ? { enviadaTesoreriaAt: { not: null } } : {}),
    },
    select: {
      id: true, solicitudId: true, supplierId: true, supplierNombre: true, tieneCredito: true, diasCredito: true,
      total: true, estado: true, enviadaTesoreriaAt: true, pagoAutorizadoPorId: true, fechaProgramada: true,
      pagadaAt: true, referenciaPago: true, createdAt: true,
      aplicaciones: { select: { monto: true, pago: { select: { id: true, fecha: true, referencia: true, monto: true } } } },
      solicitud: {
        select: {
          folio: true, area: true, notas: true, aprobadaAt: true, aprobadaPorId: true, creadaPorId: true, createdAt: true,
          supplier: { select: { id: true, razonSocial: true, rfc: true, clabe: true, banco: true } },
          partidas: {
            select: { id: true, descripcion: true, unidad: true, cantidad: true, cantidadRecibida: true, precioUnitario: true, importe: true, hospInsumoId: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  if (adjs.length === 0) return [];

  const vinculos = await db.construccionCfdiVinculo.findMany({
    where: { companyId, targetTipo: VINCULO_ORDEN, targetId: { in: adjs.map((a) => a.id) } },
    select: {
      targetId: true,
      invoice: {
        select: {
          id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, metodoPago: true, status: true,
          conciliacionDetalles: { select: { montoAsignado: true } },
        },
      },
    },
  });
  const amparado = await amparadoPorReps(db, vinculos.map((v) => v.invoice.uuid));
  const cfdisDe = new Map<string, typeof vinculos>();
  for (const v of vinculos) cfdisDe.set(v.targetId!, [...(cfdisDe.get(v.targetId!) ?? []), v]);

  return adjs.map((a) => {
    const total = r2(Number(a.total));
    const aplicado = r2(a.aplicaciones.reduce((s, x) => s + Number(x.monto), 0));
    const saldo = r2(saldoDe({ total, estado: a.estado }, aplicado));
    const partidas = a.solicitud.partidas.map((p) => ({
      id: p.id,
      descripcion: p.descripcion,
      unidad: p.unidad,
      hospInsumoId: p.hospInsumoId,
      cantidad: Number(p.cantidad),
      recibida: Number(p.cantidadRecibida),
      precioUnitario: Number(p.precioUnitario),
      importe: Number(p.importe),
    }));
    const recepcionCompleta = partidas.every((p) => p.recibida >= p.cantidad - 1e-6);
    const algoRecibido = partidas.some((p) => p.recibida > 0);
    const cfdis = (cfdisDe.get(a.id) ?? [])
      .filter((v) => v.invoice.status !== "CANCELLED")
      .map((v) => {
        const t = r2(Number(v.invoice.total));
        const ev = pagadoPorEvidencia({
          metodoPago: v.invoice.metodoPago,
          total: t,
          conciliado: conciliadoDe(v.invoice.conciliacionDetalles),
          amparadoRep: amparadoDe(amparado, v.invoice.uuid),
        });
        return {
          id: v.invoice.id, uuid: v.invoice.uuid, serie: v.invoice.serie, folio: v.invoice.folio,
          fecha: v.invoice.fecha, total: t, metodoPago: v.invoice.metodoPago,
          conciliado: conciliadoDe(v.invoice.conciliacionDetalles), pagadoConEvidencia: ev.pagado, repPendiente: ev.repPendiente,
        };
      });
    const facturado = r2(cfdis.reduce((s, c) => s + c.total, 0));
    const conciliadoBanco = r2(cfdis.reduce((s, c) => s + c.conciliado, 0));
    // Conciliada = el banco ya mostró la salida por lo pagado.
    const conciliado = aplicado > EPS && conciliadoBanco >= aplicado - EPS;
    const vencimiento = vencimientoDe({
      aprobadaAt: a.solicitud.aprobadaAt,
      tieneCredito: a.tieneCredito,
      diasCredito: a.diasCredito,
      fechasCfdi: cfdis.map((c) => c.fecha),
    });
    const autorizada = !!a.enviadaTesoreriaAt;
    return {
      id: a.id,
      solicitudId: a.solicitudId,
      folio: a.solicitud.folio,
      area: a.solicitud.area,
      notas: a.solicitud.notas,
      creadaPorId: a.solicitud.creadaPorId,
      aprobadaAt: a.solicitud.aprobadaAt,
      aprobadaPorId: a.solicitud.aprobadaPorId,
      proveedor: a.solicitud.supplier ?? { id: a.supplierId, razonSocial: a.supplierNombre, rfc: null, clabe: null, banco: null },
      credito: { tieneCredito: a.tieneCredito, diasCredito: a.diasCredito },
      total,
      autorizado: r2(partidas.reduce((s, p) => s + p.importe, 0)),
      partidas,
      recepcion: recepcionCompleta ? "COMPLETA" : algoRecibido ? "PARCIAL" : "PENDIENTE",
      cfdis,
      facturado,
      diferenciaFactura: cfdis.length ? r2(facturado - partidas.reduce((s, p) => s + p.importe, 0)) : null,
      vencimiento,
      diasParaVencer: vencimiento ? Math.floor((vencimiento.getTime() - hoy.getTime()) / DIA) : null,
      pago: {
        aplicado,
        saldo,
        estado: a.estado,
        pagos: a.aplicaciones.map((x) => ({ id: x.pago.id, fecha: x.pago.fecha, referencia: x.pago.referencia, monto: r2(Number(x.monto)) })),
      },
      autorizacionPago: autorizada
        ? { at: a.enviadaTesoreriaAt, porId: a.pagoAutorizadoPorId, fechaProgramada: a.fechaProgramada }
        : null,
      conciliado,
      etapa: etapaDe({ saldo, total, recepcionCompleta, facturado, autorizada, conciliado }),
    };
  });
}

export type OrdenDeCompra = Awaited<ReturnType<typeof ordenesDeCompra>>[number];

async function cargarOrden(db: Db, ordenId: string, companyId?: string) {
  const a = await db.solicitudAdjudicacion.findUnique({
    where: { id: ordenId },
    select: {
      id: true, companyId: true, estado: true, total: true, supplierId: true, supplierNombre: true, solicitudId: true,
      enviadaTesoreriaAt: true, pagoAutorizadoPorId: true,
      solicitud: { select: { origen: true, folio: true, creadaPorId: true, aprobadaAt: true, supplier: { select: { rfc: true } } } },
    },
  });
  if (!a || a.solicitud.origen !== ORIGEN_HOSPITAL || (companyId && a.companyId !== companyId)) {
    throw new HospitalError(404, "Orden de compra no encontrada");
  }
  return a;
}

export async function companyDeOrden(ordenId: string): Promise<string> {
  return (await cargarOrden(prisma, ordenId)).companyId;
}

// ── CFDI de la orden (el cruce orden ↔ factura) ─────────────────────────────

const rfcDeCfdi = (f: { customer: { rfc: string } | null; contraparteRfc: string | null }) =>
  (f.customer?.rfc ?? f.contraparteRfc ?? "").toUpperCase();

/**
 * Facturas del proveedor de la orden que todavía no están ligadas a nada,
 * ordenadas por cercanía al total de la orden. Desde 30 días antes de la
 * autorización (hay proveedores que facturan al cotizar).
 */
export async function candidatosCfdi(ordenId: string, companyId: string) {
  const o = await cargarOrden(prisma, ordenId, companyId);
  const rfc = o.solicitud.supplier?.rfc?.toUpperCase();
  if (!rfc) return [];
  const desde = new Date((o.solicitud.aprobadaAt ?? new Date()).getTime() - 30 * DIA);
  const facturas = await prisma.invoice.findMany({
    where: {
      companyId, tipo: "EGRESO", status: { not: "CANCELLED" }, fecha: { gte: desde },
      OR: [{ customer: { rfc } }, { contraparteRfc: rfc }],
      NOT: { tipoSat: "E" },
    },
    select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, metodoPago: true, customer: { select: { rfc: true } }, contraparteRfc: true },
    orderBy: { fecha: "desc" },
    take: 100,
  });
  const ligadas = new Set(
    (await prisma.construccionCfdiVinculo.findMany({ where: { invoiceId: { in: facturas.map((f) => f.id) } }, select: { invoiceId: true } })).map((v) => v.invoiceId)
  );
  const total = Number(o.total);
  return facturas
    .filter((f) => !ligadas.has(f.id) && rfcDeCfdi(f) === rfc)
    .map((f) => ({
      id: f.id, uuid: f.uuid, serie: f.serie, folio: f.folio, fecha: f.fecha, total: r2(Number(f.total)), metodoPago: f.metodoPago,
      diferencia: r2(Number(f.total) - total),
    }))
    .sort((a, b) => Math.abs(a.diferencia) - Math.abs(b.diferencia));
}

/** Liga la factura a la orden. Debe ser del mismo proveedor; una factura va a una sola orden. */
export async function vincularCfdi(ordenId: string, companyId: string, invoiceId: string) {
  const o = await cargarOrden(prisma, ordenId, companyId);
  const f = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, tipo: true, status: true, total: true, customer: { select: { rfc: true } }, contraparteRfc: true },
  });
  if (!f) throw new HospitalError(404, "CFDI no encontrado en esta empresa");
  if (f.tipo !== "EGRESO") throw new HospitalError(422, "Sólo se liga una factura recibida de proveedor");
  if (f.status === "CANCELLED") throw new HospitalError(422, "El CFDI está cancelado");
  const rfc = o.solicitud.supplier?.rfc?.toUpperCase();
  if (!rfc || rfcDeCfdi(f) !== rfc) throw new HospitalError(422, "El CFDI es de otro proveedor");
  const previo = await prisma.construccionCfdiVinculo.findUnique({ where: { invoiceId }, select: { targetId: true } });
  if (previo && previo.targetId !== ordenId) throw new HospitalError(409, "Ese CFDI ya está ligado a otra orden o gasto");
  const r = await prisma.$transaction(async (tx) => {
    await tx.construccionCfdiVinculo.upsert({
      where: { invoiceId },
      create: { invoiceId, companyId, estado: "VINCULADA", targetTipo: VINCULO_ORDEN, targetId: ordenId, targetLabel: o.solicitud.folio },
      update: { estado: "VINCULADA", targetTipo: VINCULO_ORDEN, targetId: ordenId, targetLabel: o.solicitud.folio },
    });
    return recalcularTotalOrden(tx, ordenId);
  });
  return { ordenId, invoiceId, diferencia: r2(r.facturado - r.autorizado), aPagar: r.total };
}

export async function desvincularCfdi(ordenId: string, companyId: string, invoiceId: string) {
  await cargarOrden(prisma, ordenId, companyId);
  return prisma.$transaction(async (tx) => {
    const n = await tx.construccionCfdiVinculo.deleteMany({ where: { invoiceId, companyId, targetTipo: VINCULO_ORDEN, targetId: ordenId } });
    if (n.count === 0) throw new HospitalError(404, "Ese CFDI no está ligado a esta orden");
    const r = await recalcularTotalOrden(tx, ordenId);
    return { ordenId, invoiceId, aPagar: r.total };
  });
}

/**
 * Lo que se le debe al proveedor: la(s) factura(s) ligada(s) vigentes; sin
 * factura, lo autorizado (Σ líneas de la requisición). La requisición lleva
 * precios estimados y la factura trae el IVA y el precio real, así que en
 * cuanto llega el CFDI la orden se paga por el CFDI. El motor de pagos
 * (aplicarPago) topa contra `adjudicacion.total`, por eso se reescribe aquí.
 * No baja de lo ya pagado: si la factura es menor que lo pagado, se rechaza.
 */
export async function recalcularTotalOrden(tx: Prisma.TransactionClient, ordenId: string) {
  const a = await tx.solicitudAdjudicacion.findUniqueOrThrow({
    where: { id: ordenId },
    select: { id: true, companyId: true, solicitud: { select: { partidas: { select: { importe: true } } } } },
  });
  const autorizado = r2(a.solicitud.partidas.reduce((s, p) => s + Number(p.importe), 0));
  const vinculos = await tx.construccionCfdiVinculo.findMany({
    where: { companyId: a.companyId, targetTipo: VINCULO_ORDEN, targetId: ordenId },
    select: { invoice: { select: { total: true, status: true } } },
  });
  const facturado = r2(vinculos.filter((v) => v.invoice.status !== "CANCELLED").reduce((s, v) => s + Number(v.invoice.total), 0));
  const total = totalAPagar(autorizado, facturado);
  const aplicado = await aplicadoDeAdjudicacion(tx, ordenId);
  if (total < aplicado - EPS) {
    throw new HospitalError(409, `Ya se pagaron ${aplicado.toFixed(2)} y la factura ligada suma ${total.toFixed(2)}: revisa la factura o pide una nota de crédito.`);
  }
  await tx.solicitudAdjudicacion.update({ where: { id: ordenId }, data: { total } });
  await recomputeAdjudicacionEstado(tx, ordenId, new Date());
  return { autorizado, facturado, total };
}

/** Con factura ligada se paga la factura; sin ella, lo autorizado. */
export function totalAPagar(autorizado: number, facturado: number): number {
  return facturado > EPS ? r2(facturado) : r2(autorizado);
}

// ── Autorización de pago y tesorería ────────────────────────────────────────

export async function autorizarPago(ordenId: string, companyId: string, userId: string, fechaProgramada?: Date | null) {
  const o = await cargarOrden(prisma, ordenId, companyId);
  if (o.estado !== "POR_PAGAR" && o.estado !== "PARCIAL") throw new HospitalError(409, "La orden ya está pagada");
  if (o.solicitud.creadaPorId === userId) {
    throw new HospitalError(403, "No autorizas el pago de una compra que tú pediste: lo autoriza otra persona.");
  }
  await prisma.solicitudAdjudicacion.update({
    where: { id: ordenId },
    data: { enviadaTesoreriaAt: new Date(), pagoAutorizadoPorId: userId, fechaProgramada: fechaProgramada ?? null },
  });
  return { ordenId, folio: o.solicitud.folio };
}

export async function revocarAutorizacionPago(ordenId: string, companyId: string) {
  const o = await cargarOrden(prisma, ordenId, companyId);
  if (!o.enviadaTesoreriaAt) throw new HospitalError(409, "La orden no tiene el pago autorizado");
  if (o.estado !== "POR_PAGAR") throw new HospitalError(409, "Ya hay pagos registrados: la autorización no se retira");
  await prisma.solicitudAdjudicacion.update({
    where: { id: ordenId },
    data: { enviadaTesoreriaAt: null, pagoAutorizadoPorId: null, fechaProgramada: null },
  });
  return { ordenId, folio: o.solicitud.folio };
}

export interface PagoInput {
  fecha?: Date;
  monto?: number;
  referencia?: string | null;
  comprobante?: { data: string; mime?: string; name?: string } | null;
}

/**
 * Tesorería registra el pago de una orden con el pago autorizado: un
 * PagoProveedor aplicado a la orden (parciales permitidos). No toca el banco
 * ni el mayor; la salida real se concilia después contra la factura.
 */
export async function registrarPago(ordenId: string, companyId: string, userId: string, input: PagoInput) {
  const o = await cargarOrden(prisma, ordenId, companyId);
  if (!o.enviadaTesoreriaAt) throw new HospitalError(409, "El pago de esta orden no está autorizado");
  if (o.pagoAutorizadoPorId === userId) {
    throw new HospitalError(403, "Quien autorizó el pago no lo registra: lo ejecuta tesorería.");
  }
  const fecha = input.fecha ?? new Date();
  return prisma.$transaction(async (tx) => {
    const aplicado = await aplicadoDeAdjudicacion(tx, o.id);
    const saldo = saldoDe({ total: Number(o.total), estado: o.estado }, aplicado);
    if (saldo <= EPS) throw new HospitalError(409, "La orden ya está saldada");
    if (input.monto != null && input.monto > saldo + EPS) {
      throw new HospitalError(400, `El monto excede el saldo de la orden (${r2(saldo).toFixed(2)}). Registra lo que realmente salió del banco.`);
    }
    const monto = r2(input.monto ?? saldo);
    if (!(monto > 0)) throw new HospitalError(400, "Monto inválido");
    const pago = await tx.pagoProveedor.create({
      data: {
        companyId,
        supplierId: o.supplierId ?? null,
        supplierNombre: o.supplierNombre,
        fecha,
        monto,
        referencia: input.referencia?.trim() || null,
        notas: `Orden ${o.solicitud.folio}`,
        comprobanteData: input.comprobante?.data ?? null,
        comprobanteMime: input.comprobante?.mime ?? null,
        comprobanteName: input.comprobante?.name ?? null,
      },
    });
    await aplicarPago(tx, { id: pago.id, companyId, supplierId: o.supplierId ?? null, monto }, [{ adjudicacionId: o.id, monto }], fecha);
    await tx.solicitudAdjudicacion.update({
      where: { id: o.id },
      data: {
        referenciaPago: input.referencia?.trim() || undefined,
        comprobanteData: input.comprobante?.data ?? undefined,
        comprobanteMime: input.comprobante?.mime ?? undefined,
        comprobanteName: input.comprobante?.name ?? undefined,
      },
    });
    return { ordenId: o.id, pagoId: pago.id, monto, saldo: r2(saldo - monto) };
  });
}
