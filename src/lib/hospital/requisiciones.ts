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
  /** Línea de la bandeja de compras que esta partida atiende. */
  lineaAreaId?: string | null;
}

/** Oferta de un proveedor: precio por partida (mismo orden; null = no la cotizó) y sus condiciones. */
export interface CotizacionInput {
  supplierId: string;
  /** Sin dato, salen del padrón del proveedor (SupplierTerms). */
  tieneCredito?: boolean | null;
  diasCredito?: number | null;
  diasEntrega?: number | null;
  vigenciaHasta?: Date | null;
  notas?: string | null;
  precios: Array<number | null>;
}

export interface RequisicionInput {
  /** Requisición de un solo proveedor (los precios van en las partidas). Con `cotizaciones` no se usa. */
  supplierId?: string | null;
  area?: string | null;
  notas?: string | null;
  fechaEntrega?: Date | null;
  partidas: PartidaInput[];
  /** Varias ofertas para comparar; quien autoriza elige la ganadora por línea. */
  cotizaciones?: CotizacionInput[] | null;
  /** Índice de la cotización ganadora por partida; sin él, la más barata. */
  ganadoras?: Array<number | null> | null;
}

// ── Requisición ─────────────────────────────────────────────────────────────

/** Una requisición de un solo proveedor es una sola cotización con los precios de sus partidas. */
export function cotizacionesDe(input: RequisicionInput): CotizacionInput[] {
  if (input.cotizaciones?.length) return input.cotizaciones;
  if (!input.supplierId) throw new HospitalError(400, "Elige el proveedor (o dalo de alta)");
  return [{ supplierId: input.supplierId, precios: input.partidas.map((p) => p.precioUnitario) }];
}

/**
 * La cotización ganadora de cada partida: la elegida si la cotizó; si no, la
 * más barata (en empate, la primera). Toda partida debe tener al menos un precio.
 */
export function elegirGanadoras(
  partidas: Array<{ descripcion: string }>,
  cotizaciones: Array<{ precios: Array<number | null> }>,
  elegidas?: Array<number | null> | null
): number[] {
  return partidas.map((p, i) => {
    const e = elegidas?.[i];
    if (e != null) {
      if (cotizaciones[e]?.precios[i] == null) throw new HospitalError(422, `«${p.descripcion}»: la cotización elegida no tiene precio para esta línea`);
      return e;
    }
    let mejor = -1;
    cotizaciones.forEach((c, k) => {
      const v = c.precios[i];
      if (v != null && (mejor < 0 || v < (cotizaciones[mejor].precios[i] as number))) mejor = k;
    });
    if (mejor < 0) throw new HospitalError(422, `«${p.descripcion}»: ningún proveedor la cotizó`);
    return mejor;
  });
}

type Proveedor = { id: string; razonSocial: string; terms: { tieneCredito: boolean; diasCredito: number } | null };

async function validarProveedoresEInsumos(db: Db, companyId: string, input: RequisicionInput) {
  const cots = cotizacionesDe(input);
  const ids = cots.map((c) => c.supplierId);
  if (new Set(ids).size !== ids.length) throw new HospitalError(400, "Un proveedor va una sola vez: junta sus precios en una cotización");
  for (const c of cots) {
    if (c.precios.length !== input.partidas.length) throw new HospitalError(400, "Cada cotización lleva un precio (o vacío) por línea");
  }
  const suppliers = await db.supplier.findMany({
    where: { id: { in: ids }, companyId },
    select: { id: true, razonSocial: true, terms: { select: { tieneCredito: true, diasCredito: true } } },
  });
  if (suppliers.length !== ids.length) throw new HospitalError(404, "Proveedor no encontrado en esta empresa");
  const insumos = [...new Set(input.partidas.map((p) => p.hospInsumoId).filter((x): x is string => !!x))];
  if (insumos.length) {
    const n = await db.hospInsumo.count({ where: { companyId, id: { in: insumos } } });
    if (n !== insumos.length) throw new HospitalError(404, "Algún insumo no es de esta empresa");
  }
  const ganadoras = elegirGanadoras(input.partidas, cots, input.ganadoras);
  return { cots, ganadoras, porId: new Map<string, Proveedor>(suppliers.map((s) => [s.id, s])) };
}

/**
 * Partidas + una cotización por proveedor, con la ganadora de cada línea. El
 * precio de la partida es el de su ganadora; el encabezado lleva el
 * proveedor con más monto adjudicado y su forma de pago. Devuelve el total.
 */
async function armarLineas(
  tx: Prisma.TransactionClient,
  companyId: string,
  solicitudId: string,
  partidas: PartidaInput[],
  cots: CotizacionInput[],
  ganadoras: number[],
  porId: Map<string, Proveedor>
): Promise<number> {
  const creadas: string[] = [];
  const ligas: Array<{ lineaAreaId: string; partidaId: string }> = [];
  for (const [i, p] of partidas.entries()) {
    const precio = cots[ganadoras[i]].precios[i] as number;
    const row = await tx.solicitudPartida.create({
      data: {
        solicitudId,
        hospInsumoId: p.hospInsumoId ?? null,
        descripcion: p.descripcion.trim(),
        unidad: p.unidad?.trim() || null,
        cantidad: p.cantidad,
        precioUnitario: precio,
        importe: r2(p.cantidad * precio),
      },
      select: { id: true },
    });
    creadas.push(row.id);
    if (p.lineaAreaId) ligas.push({ lineaAreaId: p.lineaAreaId, partidaId: row.id });
  }
  await ligarLineasArea(tx, companyId, solicitudId, ligas);

  for (const [k, c] of cots.entries()) {
    const s = porId.get(c.supplierId)!;
    const credito = c.tieneCredito ?? s.terms?.tieneCredito ?? false;
    const lineas = partidas
      .map((p, i) => ({ i, precio: c.precios[i] }))
      .filter((x): x is { i: number; precio: number } => x.precio != null)
      .map((x) => ({ solicitudPartidaId: creadas[x.i], precioUnitario: x.precio, importe: r2(partidas[x.i].cantidad * x.precio) }));
    const cot = await tx.solicitudCompraCotizacion.create({
      data: {
        solicitudId,
        supplierId: s.id,
        supplierNombre: s.razonSocial,
        tieneCredito: credito,
        diasCredito: credito ? c.diasCredito ?? s.terms?.diasCredito ?? 0 : null,
        diasEntrega: c.diasEntrega ?? null,
        vigenciaHasta: c.vigenciaHasta ?? null,
        notas: c.notas?.trim() || null,
        total: r2(lineas.reduce((a, l) => a + l.importe, 0)),
        isSelected: ganadoras.includes(k),
        partidas: { create: lineas },
      },
      select: { id: true },
    });
    const suyas = creadas.filter((_, i) => ganadoras[i] === k);
    if (suyas.length) await tx.solicitudPartida.updateMany({ where: { id: { in: suyas } }, data: { cotizacionGanadoraId: cot.id } });
  }
  return resumirEncabezado(tx, solicitudId);
}

/** Total, proveedor principal (más monto adjudicado) y su forma de pago, desde las ganadoras. */
async function resumirEncabezado(tx: Prisma.TransactionClient, solicitudId: string): Promise<number> {
  const partidas = await tx.solicitudPartida.findMany({
    where: { solicitudId },
    select: { importe: true, cotizacionGanadora: { select: { supplierId: true, tieneCredito: true } } },
  });
  const total = r2(partidas.reduce((a, p) => a + Number(p.importe), 0));
  const porProveedor = new Map<string, { monto: number; credito: boolean }>();
  for (const p of partidas) {
    const sid = p.cotizacionGanadora?.supplierId;
    if (!sid) continue;
    const e = porProveedor.get(sid) ?? { monto: 0, credito: p.cotizacionGanadora!.tieneCredito };
    e.monto += Number(p.importe);
    porProveedor.set(sid, e);
  }
  const [principal] = [...porProveedor].sort((a, b) => b[1].monto - a[1].monto);
  await tx.solicitudCompra.update({
    where: { id: solicitudId },
    data: { total, supplierId: principal?.[0] ?? null, formaPago: principal?.[1].credito ? "CREDITO" : "CONTADO" },
  });
  return total;
}

/**
 * Cambia la ganadora de algunas partidas (mientras está por autorizar): la
 * partida toma el precio de esa cotización y se recalcula el encabezado.
 */
export async function reasignarGanadoras(tx: Prisma.TransactionClient, solicitudId: string, ganadoras: Record<string, string>) {
  const entradas = Object.entries(ganadoras);
  if (!entradas.length) return;
  const partidas = await tx.solicitudPartida.findMany({ where: { solicitudId, id: { in: entradas.map(([p]) => p) } }, select: { id: true, cantidad: true, descripcion: true } });
  if (partidas.length !== entradas.length) throw new HospitalError(404, "Alguna línea no es de esta requisición");
  for (const p of partidas) {
    const cotId = ganadoras[p.id];
    const oferta = await tx.solicitudCotizacionPartida.findFirst({
      where: { solicitudPartidaId: p.id, cotizacionId: cotId, cotizacion: { solicitudId } },
      select: { precioUnitario: true },
    });
    if (!oferta) throw new HospitalError(422, `«${p.descripcion}»: esa cotización no tiene precio para esta línea`);
    const precio = Number(oferta.precioUnitario);
    await tx.solicitudPartida.update({ where: { id: p.id }, data: { cotizacionGanadoraId: cotId, precioUnitario: precio, importe: r2(Number(p.cantidad) * precio) } });
  }
  const ganan = new Set((await tx.solicitudPartida.findMany({ where: { solicitudId }, select: { cotizacionGanadoraId: true } })).map((p) => p.cotizacionGanadoraId));
  const cots = await tx.solicitudCompraCotizacion.findMany({ where: { solicitudId }, select: { id: true } });
  for (const c of cots) await tx.solicitudCompraCotizacion.update({ where: { id: c.id }, data: { isSelected: ganan.has(c.id) } });
  await resumirEncabezado(tx, solicitudId);
}

export async function crearRequisicion(companyId: string, userId: string, input: RequisicionInput) {
  const v = await validarProveedoresEInsumos(prisma, companyId, input);
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
      const total = await armarLineas(tx, companyId, sol.id, input.partidas, v.cots, v.ganadoras, v.porId);
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
  const v = await validarProveedoresEInsumos(prisma, companyId, input);
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
    const total = await armarLineas(tx, companyId, id, input.partidas, v.cots, v.ganadoras, v.porId);
    return { id, folio: sol.folio, total };
  });
}

/**
 * Autoriza. Quien autoriza puede cambiar antes la ganadora de cualquier línea
 * (`ganadoras`: partidaId → cotizacionId); se genera una orden por proveedor
 * ganador.
 */
/**
 * Las líneas que quien autoriza tiene que decidir: las que cotizaron dos o
 * más proveedores y no vienen en `ganadoras`. Al armar la requisición la más
 * barata queda sólo como sugerencia; el proveedor lo elige quien autoriza.
 */
export function faltaElegir(partidas: Array<{ id: string; descripcion: string; ofertas: number }>, ganadoras?: Record<string, string> | null): string[] {
  return partidas.filter((p) => p.ofertas > 1 && !ganadoras?.[p.id]).map((p) => p.descripcion);
}

export async function aprobarRequisicion(id: string, companyId: string, userId: string, ganadoras?: Record<string, string> | null) {
  const sol = await cargarHospital(prisma, id, companyId);
  if (sol.estado !== "PENDIENTE") throw new HospitalError(409, `La requisición está ${sol.estado.toLowerCase()}: no se puede autorizar`);
  if (sol.creadaPorId === userId) throw new HospitalError(403, "No puedes autorizar tu propia requisición: la autoriza otra persona.");
  const partidas = await prisma.solicitudPartida.findMany({
    where: { solicitudId: id },
    select: { id: true, descripcion: true, _count: { select: { cotizaciones: true } } },
  });
  const pendientes = faltaElegir(partidas.map((p) => ({ id: p.id, descripcion: p.descripcion, ofertas: p._count.cotizaciones })), ganadoras);
  if (pendientes.length) throw new HospitalError(422, `Elige el proveedor de: ${pendientes.join(", ")}`);
  return prisma.$transaction(async (tx) => {
    // Condicionado al estado: dos autorizaciones simultáneas no duplican la orden.
    const n = await tx.solicitudCompra.updateMany({
      where: { id, estado: "PENDIENTE" },
      data: { estado: "APROBADA", aprobadaPorId: userId, aprobadaAt: new Date() },
    });
    if (n.count !== 1) throw new HospitalError(409, "La requisición cambió mientras se autorizaba");
    if (ganadoras) await reasignarGanadoras(tx, id, ganadoras);
    await generateAdjudicaciones(tx, id);
    const ordenes = await tx.solicitudAdjudicacion.findMany({ where: { solicitudId: id }, select: { id: true, supplierNombre: true } });
    return { id, folio: sol.folio, ordenId: ordenes[0]?.id ?? null, ordenes };
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
      liberarLineasDeRequisicion(prisma, companyId, id),
    ]);
    return { id, folio: sol.folio };
  }
  await prisma.$transaction([
    prisma.solicitudCompra.update({ where: { id }, data: { estado: "CANCELADA" } }),
    liberarLineasDeRequisicion(prisma, companyId, id),
  ]);
  return { id, folio: sol.folio };
}

// ── Líneas de la bandeja de compras (lib/hospital/bandeja-compras.ts) ───────

/**
 * Liga cada línea de área a la partida recién creada (armarLineas) y regresa
 * a la bandeja las que estaban en esta requisición y ya no traen partida
 * (se quitaron al editarla). Condicionado: sólo toma líneas libres o de esta
 * misma requisición, así dos compradores no se llevan la misma.
 */
export async function ligarLineasArea(tx: Prisma.TransactionClient, companyId: string, requisicionId: string, ligas: Array<{ lineaAreaId: string; partidaId: string }>) {
  for (const { lineaAreaId, partidaId } of ligas) {
    const n = await tx.hospSolicitudAreaLinea.updateMany({
      where: {
        id: lineaAreaId,
        companyId,
        cierre: null,
        OR: [{ requisicionId: null }, { requisicionId }, { requisicion: { estado: "CANCELADA" } }],
      },
      data: { requisicionId, solicitudPartidaId: partidaId },
    });
    if (n.count !== 1) throw new HospitalError(409, "Una de las líneas ya la tomó otra requisición o se cerró: recarga la bandeja");
  }
  await tx.hospSolicitudAreaLinea.updateMany({
    where: { companyId, requisicionId, solicitudPartidaId: null },
    data: { requisicionId: null },
  });
}

/** La requisición se canceló: sus líneas regresan a la bandeja. */
export function liberarLineasDeRequisicion(db: PrismaClient, companyId: string, requisicionId: string) {
  return db.hospSolicitudAreaLinea.updateMany({
    where: { companyId, requisicionId, cierre: null },
    data: { requisicionId: null, solicitudPartidaId: null },
  });
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
      id: true, solicitudId: true, cotizacionId: true, supplierId: true, supplierNombre: true, tieneCredito: true, diasCredito: true,
      diasEntrega: true, total: true, estado: true, enviadaTesoreriaAt: true, pagoAutorizadoPorId: true, fechaProgramada: true,
      pagadaAt: true, referenciaPago: true, createdAt: true, pedidoEnviadoAt: true, pedidoEnviadoVia: true, pedidoEnviadoPorId: true,
      aplicaciones: { select: { monto: true, pago: { select: { id: true, fecha: true, referencia: true, monto: true } } } },
      solicitud: {
        select: {
          folio: true, area: true, notas: true, aprobadaAt: true, aprobadaPorId: true, creadaPorId: true, createdAt: true,
          partidas: {
            select: { id: true, descripcion: true, unidad: true, cantidad: true, cantidadRecibida: true, precioUnitario: true, importe: true, hospInsumoId: true, cotizacionGanadoraId: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  if (adjs.length === 0) return [];
  const proveedores = new Map(
    (await db.supplier.findMany({
      where: { id: { in: [...new Set(adjs.map((a) => a.supplierId).filter((x): x is string => !!x))] } },
      select: { id: true, razonSocial: true, rfc: true, clabe: true, banco: true, email: true },
    })).map((p) => [p.id, p])
  );

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
  const amparado = await amparadoPorReps(db, companyId, vinculos.map((v) => v.invoice.uuid));
  const cfdisDe = new Map<string, typeof vinculos>();
  for (const v of vinculos) cfdisDe.set(v.targetId!, [...(cfdisDe.get(v.targetId!) ?? []), v]);

  return adjs.map((a) => {
    const total = r2(Number(a.total));
    const aplicado = r2(a.aplicaciones.reduce((s, x) => s + Number(x.monto), 0));
    const saldo = r2(saldoDe({ total, estado: a.estado }, aplicado));
    // Una requisición con varios proveedores da una orden por proveedor: cada orden lleva sus líneas ganadas.
    const partidas = a.solicitud.partidas.filter((p) => p.cotizacionGanadoraId === a.cotizacionId).map((p) => ({
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
      proveedor: (a.supplierId ? proveedores.get(a.supplierId) : null) ?? { id: a.supplierId, razonSocial: a.supplierNombre, rfc: null, clabe: null, banco: null, email: null },
      credito: { tieneCredito: a.tieneCredito, diasCredito: a.diasCredito },
      diasEntrega: a.diasEntrega,
      pedido: a.pedidoEnviadoAt ? { at: a.pedidoEnviadoAt, via: a.pedidoEnviadoVia, porId: a.pedidoEnviadoPorId } : null,
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
      id: true, companyId: true, estado: true, total: true, supplierId: true, supplierNombre: true, solicitudId: true, cotizacionId: true,
      enviadaTesoreriaAt: true, pagoAutorizadoPorId: true,
      solicitud: { select: { origen: true, folio: true, estado: true, creadaPorId: true, aprobadaAt: true } },
    },
  });
  if (!a || a.solicitud.origen !== ORIGEN_HOSPITAL || (companyId && a.companyId !== companyId)) {
    throw new HospitalError(404, "Orden de compra no encontrada");
  }
  // El RFC es el del proveedor de ESTA orden (una requisición puede tener varios).
  const proveedor = a.supplierId ? await db.supplier.findUnique({ where: { id: a.supplierId }, select: { rfc: true } }) : null;
  return { ...a, rfc: proveedor?.rfc?.toUpperCase() ?? null };
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
  const rfc = o.rfc;
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
  const rfc = o.rfc;
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
    select: { id: true, companyId: true, cotizacionId: true, solicitud: { select: { partidas: { select: { importe: true, cotizacionGanadoraId: true } } } } },
  });
  const autorizado = r2(a.solicitud.partidas.filter((p) => p.cotizacionGanadoraId === a.cotizacionId).reduce((s, p) => s + Number(p.importe), 0));
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
