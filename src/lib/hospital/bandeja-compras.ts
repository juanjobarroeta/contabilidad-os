// ─────────────────────────────────────────────────────────────────────────────
// Lo que piden las áreas → bandeja de compras → requisición por proveedor →
// autorización → pedido → recepción. Reemplaza el Excel donde compras volcaba
// todas las requisiciones para decidir cuáles mandar a autorizar.
//
//   · El área pide sin proveedor (HospSolicitudArea, folio SA-AAAA-NNNN) y
//     marca su urgencia por línea.
//   · La bandeja junta todas las líneas sin requisición. La urgencia que se ve
//     es la mayor entre la del área y la del inventario: sin existencia es
//     urgente, debajo del mínimo es semiurgente.
//   · El área puede sugerir proveedor. Compras elige líneas y captura una o
//     varias cotizaciones (precio por línea, crédito, entrega); se arma la
//     requisición (crearRequisicion) con cada línea ligada a su partida y la
//     más barata como ganadora sugerida. Quien autoriza puede cambiar la
//     ganadora por línea; sale una orden por proveedor ganador. Desde ahí el
//     camino es el de requisiciones: pedido, recepción, factura, pago.
//   · Si la requisición se cancela, sus líneas regresan a la bandeja.
//   · Lo que el proveedor no surtió: la partida se cierra en lo recibido (la
//     orden se paga por lo que llegó) y la línea regresa a la bandeja para
//     pedirla a otro proveedor, o se cierra por desabasto.
//
// Recepción, lotes y conversiones caja→pieza viven en farmacia/inventario.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospLineaAreaCierre, HospUrgencia, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { conFolioUnico, siguienteFolio } from "./folio";
import { HospitalError } from "./errores";
import { cancelarRequisicion, crearRequisicion, ORIGEN_HOSPITAL, recalcularTotalOrden, VINCULO_ORDEN } from "./requisiciones";


type Db = PrismaClient | Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const EPS = 1e-6;
const DIA = 86_400_000;

export const URGENCIAS = ["URGENTE", "SEMIURGENTE", "NORMAL"] as const satisfies readonly HospUrgencia[];
const RANGO: Record<HospUrgencia, number> = { URGENTE: 0, SEMIURGENTE: 1, NORMAL: 2 };

/** Urgencia que dicta el inventario: sin existencia, urgente; debajo del mínimo, semiurgente. Null si no es insumo. */
export function urgenciaPorExistencia(existencia: number | null, minimo: number | null): HospUrgencia | null {
  if (existencia == null) return null;
  if (existencia <= EPS) return "URGENTE";
  if (minimo != null && minimo > 0 && existencia < minimo - EPS) return "SEMIURGENTE";
  return "NORMAL";
}

/** La mayor de las dos. */
export function urgenciaEfectiva(area: HospUrgencia, inventario: HospUrgencia | null): HospUrgencia {
  return inventario && RANGO[inventario] < RANGO[area] ? inventario : area;
}

export type EstadoLineaArea =
  | "EN_BANDEJA"
  | "POR_AUTORIZAR"
  | "RECHAZADA"
  | "POR_ENVIAR"
  | "PEDIDA"
  | "PARCIAL"
  | "RECIBIDA"
  | "DESABASTO"
  | "CANCELADA";

/** Dónde va la línea, derivado de su requisición y de lo recibido. */
export function estadoLinea(l: {
  cierre: HospLineaAreaCierre | null;
  /** `pedidoEnviadoAt`: el de la orden del proveedor que ganó esta línea. */
  requisicion: { estado: string; pedidoEnviadoAt: Date | null } | null;
  partida: { cantidad: number; recibida: number } | null;
}): EstadoLineaArea {
  if (l.cierre) return l.cierre;
  const r = l.requisicion;
  if (!r || r.estado === "CANCELADA") return "EN_BANDEJA";
  if (r.estado === "PENDIENTE" || r.estado === "BORRADOR") return "POR_AUTORIZAR";
  if (r.estado === "RECHAZADA") return "RECHAZADA";
  const p = l.partida;
  if (p && p.recibida >= p.cantidad - EPS && p.cantidad > EPS) return "RECIBIDA";
  if (p && p.recibida > EPS) return "PARCIAL";
  return r.pedidoEnviadoAt ? "PEDIDA" : "POR_ENVIAR";
}

// ── Solicitud del área ──────────────────────────────────────────────────────

export interface LineaAreaInput {
  hospInsumoId?: string | null;
  descripcion: string;
  unidad?: string | null;
  cantidad: number;
  urgencia?: HospUrgencia | null;
  motivo?: string | null;
  /** Proveedor sugerido para esta línea (si no, el de la solicitud). */
  proveedorSugeridoId?: string | null;
  proveedorSugeridoNombre?: string | null;
}

export interface SolicitudAreaInput {
  area: string;
  urgencia?: HospUrgencia | null;
  notas?: string | null;
  /** Proveedor que sugiere el área: del padrón (id) o sólo el nombre. */
  proveedorSugeridoId?: string | null;
  proveedorSugeridoNombre?: string | null;
  lineas: LineaAreaInput[];
}

export async function crearSolicitudArea(companyId: string, usuario: { id: string; nombre: string | null }, input: SolicitudAreaInput) {
  const ids = [...new Set(input.lineas.map((l) => l.hospInsumoId).filter((x): x is string => !!x))];
  if (ids.length && (await prisma.hospInsumo.count({ where: { companyId, id: { in: ids } } })) !== ids.length) {
    throw new HospitalError(404, "Algún insumo no es de esta empresa");
  }
  const urgencia = input.urgencia ?? "NORMAL";
  const sugeridos = [...new Set([input.proveedorSugeridoId, ...input.lineas.map((l) => l.proveedorSugeridoId)].filter((x): x is string => !!x))];
  const proveedores = new Map(
    (await prisma.supplier.findMany({ where: { companyId, id: { in: sugeridos } }, select: { id: true, razonSocial: true } })).map((x) => [x.id, x.razonSocial])
  );
  if (proveedores.size !== sugeridos.length) throw new HospitalError(404, "El proveedor sugerido no es de esta empresa");
  const sugerido = (l: LineaAreaInput) => {
    const id = l.proveedorSugeridoId ?? (l.proveedorSugeridoNombre?.trim() ? null : input.proveedorSugeridoId) ?? null;
    const nombre = id ? proveedores.get(id)! : l.proveedorSugeridoNombre?.trim() || input.proveedorSugeridoNombre?.trim() || null;
    return { proveedorSugeridoId: id, proveedorSugeridoNombre: nombre };
  };
  return conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "solicitudArea");
      const s = await tx.hospSolicitudArea.create({
        data: {
          companyId,
          folio,
          area: input.area.trim(),
          urgencia,
          notas: input.notas?.trim() || null,
          solicitanteId: usuario.id,
          solicitanteNombre: usuario.nombre,
          lineas: {
            create: input.lineas.map((l) => ({
              companyId,
              hospInsumoId: l.hospInsumoId ?? null,
              descripcion: l.descripcion.trim(),
              unidad: l.unidad?.trim() || null,
              cantidad: l.cantidad,
              urgencia: l.urgencia ?? urgencia,
              motivo: l.motivo?.trim() || null,
              ...sugerido(l),
            })),
          },
        },
        select: { id: true, folio: true, _count: { select: { lineas: true } } },
      });
      return { id: s.id, folio: s.folio, lineas: s._count.lineas };
    })
  );
}

// ── Bandeja y seguimiento ───────────────────────────────────────────────────

/** Existencia disponible (lotes no bloqueados ni caducos) por insumo. */
export async function existenciaPorInsumo(db: Db, companyId: string, insumoIds: string[], hoy = new Date()): Promise<Map<string, number>> {
  if (!insumoIds.length) return new Map();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const filas = await db.hospLote.groupBy({
    by: ["insumoId"],
    where: { companyId, insumoId: { in: insumoIds }, bloqueado: false, OR: [{ caducidad: null }, { caducidad: { gte: inicioHoy } }] },
    _sum: { existencia: true },
  });
  return new Map(filas.map((f) => [f.insumoId, Number(f._sum.existencia ?? 0)]));
}

export interface FiltroLineas {
  /** Sólo las que esperan a compras (sin requisición y sin cerrar). */
  soloBandeja?: boolean;
  /** Sólo las que pidió este usuario. */
  solicitanteId?: string;
  area?: string;
  /** Incluir cerradas y recibidas de más de 30 días (por defecto se ocultan). */
  historico?: boolean;
}

export async function lineasArea(db: Db, companyId: string, filtro: FiltroLineas = {}, hoy = new Date()) {
  const hace30 = new Date(hoy.getTime() - 30 * DIA);
  const rows = await db.hospSolicitudAreaLinea.findMany({
    where: {
      companyId,
      AND: [
        filtro.soloBandeja ? { cierre: null, OR: [{ requisicionId: null }, { requisicion: { estado: "CANCELADA" as const } }] } : {},
        filtro.solicitanteId ? { solicitud: { solicitanteId: filtro.solicitanteId } } : {},
        filtro.area ? { solicitud: { area: filtro.area } } : {},
        filtro.historico || filtro.soloBandeja ? {} : { OR: [{ cierre: null }, { cerradaAt: { gte: hace30 } }] },
      ],
    },
    select: {
      id: true, createdAt: true, updatedAt: true, hospInsumoId: true, descripcion: true, unidad: true, cantidad: true,
      urgencia: true, motivo: true, intentos: true, proveedoresIntentados: true, cantidadSurtidaPrevia: true,
      cierre: true, cierreMotivo: true, cerradaAt: true, proveedorSugeridoId: true, proveedorSugeridoNombre: true,
      solicitud: { select: { id: true, folio: true, area: true, urgencia: true, notas: true, solicitanteId: true, solicitanteNombre: true, createdAt: true } },
      insumo: { select: { clave: true, nombre: true, unidad: true, minimo: true, maximo: true, ultimoCosto: true } },
      requisicion: { select: { id: true, folio: true, estado: true, adjudicaciones: { select: { id: true, cotizacionId: true, pedidoEnviadoAt: true } } } },
      partida: { select: { id: true, cantidad: true, cantidadRecibida: true, precioUnitario: true, cotizacionGanadora: { select: { id: true, supplierId: true, supplierNombre: true } } } },
    },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  const existencias = await existenciaPorInsumo(db, companyId, [...new Set(rows.map((r) => r.hospInsumoId).filter((x): x is string => !!x))], hoy);

  const lineas = rows.map((r) => {
    const existencia = r.hospInsumoId ? existencias.get(r.hospInsumoId) ?? 0 : null;
    const minimo = r.insumo ? Number(r.insumo.minimo) : null;
    const porInventario = urgenciaPorExistencia(existencia, minimo);
    const partida = r.partida ? { cantidad: Number(r.partida.cantidad), recibida: Number(r.partida.cantidadRecibida) } : null;
    const req = r.requisicion && r.requisicion.estado !== "CANCELADA" ? r.requisicion : null;
    const ganadora = r.partida?.cotizacionGanadora ?? null;
    const orden = req?.adjudicaciones.find((a) => a.cotizacionId === ganadora?.id) ?? null;
    const requisicion = req ? { ...req, pedidoEnviadoAt: orden?.pedidoEnviadoAt ?? null } : null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      solicitud: r.solicitud,
      hospInsumoId: r.hospInsumoId,
      clave: r.insumo?.clave ?? null,
      descripcion: r.descripcion,
      unidad: r.unidad ?? r.insumo?.unidad ?? null,
      cantidad: Number(r.cantidad),
      surtidoPrevio: Number(r.cantidadSurtidaPrevia),
      motivo: r.motivo,
      urgenciaArea: r.urgencia,
      urgenciaInventario: porInventario,
      urgencia: urgenciaEfectiva(r.urgencia, porInventario),
      existencia,
      minimo,
      maximo: r.insumo?.maximo != null ? Number(r.insumo.maximo) : null,
      ultimoCosto: r.insumo?.ultimoCosto != null ? Number(r.insumo.ultimoCosto) : null,
      diasEsperando: Math.max(0, Math.floor((hoy.getTime() - r.solicitud.createdAt.getTime()) / DIA)),
      intentos: r.intentos,
      proveedoresIntentados: r.proveedoresIntentados,
      proveedorSugerido: r.proveedorSugeridoNombre ? { id: r.proveedorSugeridoId, razonSocial: r.proveedorSugeridoNombre } : null,
      requisicion: requisicion
        ? { id: requisicion.id, folio: requisicion.folio, estado: requisicion.estado, ordenId: orden?.id ?? null, proveedor: ganadora ? { id: ganadora.supplierId, razonSocial: ganadora.supplierNombre } : null }
        : null,
      partida: partida && r.partida ? { id: r.partida.id, ...partida, precioUnitario: Number(r.partida.precioUnitario) } : null,
      cierre: r.cierre ? { tipo: r.cierre, motivo: r.cierreMotivo, at: r.cerradaAt } : null,
      estado: estadoLinea({ cierre: r.cierre, requisicion, partida }),
    };
  });
  return lineas.sort((a, b) => RANGO[a.urgencia] - RANGO[b.urgencia] || b.diasEsperando - a.diasEsperando);
}

export type LineaArea = Awaited<ReturnType<typeof lineasArea>>[number];

// ── Armar requisiciones desde la bandeja ────────────────────────────────────

export interface CotizacionBandeja {
  supplierId: string;
  tieneCredito?: boolean | null;
  diasCredito?: number | null;
  diasEntrega?: number | null;
  vigenciaHasta?: Date | null;
  notas?: string | null;
  /** Precio por línea de la bandeja; la que no cotizó no va. */
  precios: Array<{ lineaId: string; precioUnitario: number }>;
}

export interface RequisicionBandeja {
  notas?: string | null;
  fechaEntrega?: Date | null;
  lineas: Array<{ lineaId: string; cantidad: number; descripcion?: string | null; unidad?: string | null }>;
  cotizaciones: CotizacionBandeja[];
  /** Ganadora sugerida por línea (lineaId → índice de cotización); sin ella, la más barata. */
  ganadoras?: Record<string, number> | null;
}

/**
 * Una requisición con las líneas elegidas de la bandeja y las cotizaciones
 * de uno o varios proveedores. Cada línea debe seguir en la bandeja (nadie
 * más la tomó) y tener al menos un precio. Nace por autorizar.
 */
export async function requisicionarLineas(companyId: string, userId: string, input: RequisicionBandeja) {
  const ids = input.lineas.map((l) => l.lineaId);
  if (new Set(ids).size !== ids.length) throw new HospitalError(400, "Una línea va una sola vez");
  const lineas = await prisma.hospSolicitudAreaLinea.findMany({
    where: { id: { in: ids }, companyId },
    select: { id: true, hospInsumoId: true, descripcion: true, unidad: true, cierre: true, requisicionId: true, requisicion: { select: { estado: true } }, solicitud: { select: { area: true } } },
  });
  if (lineas.length !== ids.length) throw new HospitalError(404, "Alguna línea no es de esta empresa");
  const porId = new Map(lineas.map((l) => [l.id, l]));
  for (const l of lineas) {
    if (l.cierre) throw new HospitalError(409, `«${l.descripcion}» ya se cerró`);
    if (l.requisicionId && l.requisicion?.estado !== "CANCELADA") throw new HospitalError(409, `«${l.descripcion}» ya está en otra requisición`);
  }
  for (const c of input.cotizaciones) {
    for (const x of c.precios) if (!porId.has(x.lineaId) || !ids.includes(x.lineaId)) throw new HospitalError(400, "Un precio es de una línea que no va en la requisición");
  }

  const areas = [...new Set(lineas.map((l) => l.solicitud.area))];
  return crearRequisicion(companyId, userId, {
    area: areas.length === 1 ? areas[0] : "Varias áreas",
    notas: input.notas ?? null,
    fechaEntrega: input.fechaEntrega ?? null,
    partidas: input.lineas.map((x) => {
      const l = porId.get(x.lineaId)!;
      return {
        hospInsumoId: l.hospInsumoId,
        descripcion: x.descripcion?.trim() || l.descripcion,
        unidad: x.unidad?.trim() || l.unidad,
        cantidad: x.cantidad,
        precioUnitario: 0,
        lineaAreaId: l.id,
      };
    }),
    cotizaciones: input.cotizaciones.map((c) => {
      const precio = new Map(c.precios.map((x) => [x.lineaId, x.precioUnitario]));
      return { ...c, precios: input.lineas.map((x) => precio.get(x.lineaId) ?? null) };
    }),
    ganadoras: input.ganadoras ? input.lineas.map((x) => input.ganadoras?.[x.lineaId] ?? null) : null,
  });
}

// ── Cierres ─────────────────────────────────────────────────────────────────

/** Compras cierra líneas de la bandeja: desabasto (no se consigue) o cancelada (ya no se necesita). */
export async function cerrarLineas(companyId: string, userId: string, lineaIds: string[], cierre: HospLineaAreaCierre, motivo: string) {
  const n = await prisma.hospSolicitudAreaLinea.updateMany({
    where: {
      id: { in: lineaIds },
      companyId,
      cierre: null,
      OR: [{ requisicionId: null }, { requisicion: { estado: { in: ["CANCELADA", "RECHAZADA"] } } }],
    },
    data: { cierre, cierreMotivo: motivo.trim(), cerradaAt: new Date(), cerradaPorId: userId, requisicionId: null, solicitudPartidaId: null },
  });
  if (n.count !== lineaIds.length) {
    throw new HospitalError(409, n.count === 0 ? "Esas líneas ya no están en la bandeja" : `Se cerraron ${n.count} de ${lineaIds.length}: las demás ya van en una requisición`);
  }
  return { cerradas: n.count };
}

export type AccionFaltante = "REENVIAR" | "DESABASTO";

/**
 * El proveedor no surtió todo de una línea de la orden. La partida se cierra
 * en lo recibido (cantidad = recibida; la orden se paga por lo que llegó) y lo
 * que faltó regresa a la bandeja para pedirlo a otro proveedor, o se cierra
 * por desabasto. Si con eso la orden queda en cero, la requisición se cancela.
 * Una partida sin línea de área (requisición directa) crea su línea al
 * regresar, para que no se pierda.
 */
export async function cerrarFaltante(partidaId: string, companyId: string, userId: string, accion: AccionFaltante, motivo: string) {
  const p = await prisma.solicitudPartida.findUnique({
    where: { id: partidaId },
    select: {
      id: true, cantidad: true, cantidadRecibida: true, precioUnitario: true, descripcion: true, unidad: true, hospInsumoId: true,
      cotizacionGanadora: { select: { id: true, supplierNombre: true } },
      solicitud: { select: { id: true, companyId: true, origen: true, estado: true, folio: true, area: true } },
      hospLineaArea: { select: { id: true, cantidad: true, cantidadSurtidaPrevia: true } },
    },
  });
  if (!p || p.solicitud.companyId !== companyId || p.solicitud.origen !== ORIGEN_HOSPITAL) throw new HospitalError(404, "Línea de orden no encontrada");
  if (p.solicitud.estado !== "APROBADA") throw new HospitalError(409, "Sólo se cierra lo faltante de una orden autorizada sin pagar");
  const cantidad = Number(p.cantidad);
  const recibida = Number(p.cantidadRecibida);
  const falta = r6(cantidad - recibida);
  if (falta <= EPS) throw new HospitalError(409, "Esta línea ya se recibió completa");
  const proveedor = p.cotizacionGanadora?.supplierNombre ?? "proveedor";
  const ahora = new Date();
  const nota = motivo.trim();

  const resultado = await prisma.$transaction(async (tx) => {
    // Condicionado: una recepción simultánea no se pierde.
    const n = await tx.$executeRaw`UPDATE "SolicitudPartida" SET cantidad = "cantidadRecibida", importe = round("cantidadRecibida" * "precioUnitario", 2) WHERE id = ${partidaId} AND "cantidadRecibida" = ${recibida}`;
    if (n !== 1) throw new HospitalError(409, "La línea cambió mientras se cerraba: recarga");
    await tx.solicitudCotizacionPartida.updateMany({ where: { solicitudPartidaId: partidaId }, data: { importe: r2(recibida * Number(p.precioUnitario)) } });

    let lineaId = p.hospLineaArea?.id ?? null;
    const comun = {
      requisicionId: null,
      solicitudPartidaId: null,
      ...(accion === "DESABASTO" ? { cierre: "DESABASTO" as const, cierreMotivo: nota, cerradaAt: ahora, cerradaPorId: userId } : {}),
    };
    if (lineaId) {
      await tx.hospSolicitudAreaLinea.update({
        where: { id: lineaId },
        data: {
          ...comun,
          cantidad: falta,
          cantidadSurtidaPrevia: { increment: recibida },
          intentos: { increment: 1 },
          proveedoresIntentados: { push: proveedor },
          motivo: nota ? `No surtió ${proveedor}: ${nota}` : `No surtió ${proveedor}`,
        },
      });
    } else {
      const folio = await siguienteFolio(tx, companyId, "solicitudArea");
      const s = await tx.hospSolicitudArea.create({
        data: {
          companyId, folio, area: p.solicitud.area ?? "Compras", urgencia: "NORMAL",
          notas: `Faltante de ${p.solicitud.folio}`, solicitanteId: userId,
          lineas: {
            create: {
              companyId, hospInsumoId: p.hospInsumoId, descripcion: p.descripcion, unidad: p.unidad, cantidad: falta,
              intentos: 1, proveedoresIntentados: [proveedor], cantidadSurtidaPrevia: recibida,
              motivo: nota ? `No surtió ${proveedor}: ${nota}` : `No surtió ${proveedor}`,
              ...(accion === "DESABASTO" ? { cierre: "DESABASTO" as const, cierreMotivo: nota, cerradaAt: ahora, cerradaPorId: userId } : {}),
            },
          },
        },
        select: { lineas: { select: { id: true } } },
      });
      lineaId = s.lineas[0].id;
    }

    const restantes = await tx.solicitudPartida.findMany({ where: { solicitudId: p.solicitud.id }, select: { importe: true, cantidad: true, cotizacionGanadoraId: true } });
    const total = r2(restantes.reduce((s, x) => s + Number(x.importe), 0));
    await tx.solicitudCompra.update({ where: { id: p.solicitud.id }, data: { total } });
    // La orden de ESTE proveedor (una requisición puede tener varias).
    const orden = await tx.solicitudAdjudicacion.findFirst({
      where: { solicitudId: p.solicitud.id, cotizacionId: p.cotizacionGanadora?.id ?? "" },
      select: { id: true, aplicaciones: { select: { id: true } } },
    });
    let ordenVaciaQuitada = false;
    if (orden) {
      // Topa contra lo ya pagado: si se pagó más de lo que queda, no se cierra.
      await recalcularTotalOrden(tx, orden.id);
      const suyas = restantes.filter((x) => x.cotizacionGanadoraId === p.cotizacionGanadora?.id);
      const sinFactura = (await tx.construccionCfdiVinculo.count({ where: { companyId, targetTipo: VINCULO_ORDEN, targetId: orden.id } })) === 0;
      // A este proveedor no le quedó nada: su orden se quita si no tiene factura ni pagos.
      if (suyas.every((x) => Number(x.cantidad) <= EPS) && orden.aplicaciones.length === 0 && sinFactura) {
        await tx.solicitudAdjudicacion.delete({ where: { id: orden.id } });
        ordenVaciaQuitada = true;
      }
    }
    return { lineaId, vacia: restantes.every((x) => Number(x.cantidad) <= EPS), ordenVaciaQuitada };
  });

  // Nada llegó de toda la orden: se cancela con sus propias reglas (si ya
  // tiene factura ligada no se puede; la orden queda en cero y se ve así).
  let ordenCancelada = false;
  if (resultado.vacia) {
    try {
      await cancelarRequisicion(p.solicitud.id, companyId);
      ordenCancelada = true;
    } catch (e) {
      if (!(e instanceof HospitalError)) throw e;
    }
  }
  return { partidaId, falta, lineaAreaId: resultado.lineaId, accion, ordenCancelada, ordenProveedorCancelada: resultado.ordenVaciaQuitada || ordenCancelada };
}

// ── Pedido al proveedor ─────────────────────────────────────────────────────

export const VIAS_PEDIDO = ["WHATSAPP", "CORREO", "TELEFONO", "OTRO"] as const;

/** Registra que el pedido de una orden (un proveedor) se mandó. Se puede volver a marcar: queda la última vez. */
export async function marcarPedidoEnviado(ordenId: string, companyId: string, userId: string, via: (typeof VIAS_PEDIDO)[number]) {
  const n = await prisma.solicitudAdjudicacion.updateMany({
    where: { id: ordenId, companyId, solicitud: { origen: ORIGEN_HOSPITAL, estado: { in: ["APROBADA", "PAGADA"] } } },
    data: { pedidoEnviadoAt: new Date(), pedidoEnviadoVia: via, pedidoEnviadoPorId: userId },
  });
  if (n.count !== 1) throw new HospitalError(409, "Sólo se envía el pedido de una orden autorizada");
  return { ordenId, via };
}
