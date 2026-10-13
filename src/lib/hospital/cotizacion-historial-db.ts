// La historia de la cotización contra la base: armar la foto del protocolo de
// origen, guardar cada versión y devolverlas comparadas. La comparación es
// pura (cotizacion-historial.ts).

import type { Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { armarPartidas, type PartidaArmada, type PartidaEntrada } from "./cotizacion";
import { compararCotizacion, lineasDeJson, totalLineas, type Comparacion, type LineaHistoria } from "./cotizacion-historial";

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Las partidas armadas (a tarifa/lista, antes del paquete) como líneas de la historia. */
export async function lineasDeArmado(db: Db, companyId: string, partidas: PartidaArmada[]): Promise<LineaHistoria[]> {
  const ids = [...new Set(partidas.map((p) => p.servicioId).filter(Boolean))] as string[];
  const claves = ids.length
    ? new Map((await db.hospServicio.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, clave: true } })).map((s) => [s.id, s.clave]))
    : new Map<string, string>();
  return partidas.map((p) => ({
    servicioId: p.servicioId,
    clave: p.servicioId ? claves.get(p.servicioId) ?? null : null,
    categoria: p.categoria,
    descripcion: p.descripcion,
    cantidad: p.cantidad,
    precioUnitario: p.precioUnitario,
    ivaTasa: p.ivaTasa,
    sinCotizar: p.sinCotizar ?? false,
  }));
}

/**
 * La foto del protocolo tal como salía con el tarifario del pagador: todas sus
 * partidas (las que tienen servicio, a tarifa/lista; las demás a su precio de
 * referencia o en 0) y su total — el de paquete si lo tiene.
 */
export async function fotoDeProtocolo(db: Db, companyId: string, protocoloId: string, pagadorId: string | null | undefined) {
  const pr = await db.hospProtocolo.findFirst({
    where: { id: protocoloId, companyId },
    select: { id: true, clave: true, nombre: true, version: true, precioPaquete: true, partidas: { orderBy: { orden: "asc" } } },
  });
  if (!pr) throw new HospitalError(400, "protocoloId inválido");
  const entradas: PartidaEntrada[] = pr.partidas.map((p) => ({
    servicioId: p.servicioId,
    categoria: p.categoria,
    descripcion: p.descripcion,
    cantidad: Number(p.cantidad) > 0 ? Number(p.cantidad) : 1,
    // Con servicio manda la tarifa; sin él, la referencia de la tabla o 0.
    ...(p.servicioId ? {} : { precioUnitario: p.precioReferencia == null ? 0 : r2(Number(p.precioReferencia)) }),
  }));
  const armado = entradas.length ? await armarPartidas(db, companyId, pagadorId, entradas) : { partidas: [], subtotal: 0, iva: 0, total: 0 };
  const lineas = await lineasDeArmado(db, companyId, armado.partidas);
  const totalLista = totalLineas(lineas);
  const precioPaquete = pr.precioPaquete == null ? null : Number(pr.precioPaquete);
  return {
    protocoloId: pr.id,
    protocoloClave: pr.clave,
    protocoloNombre: pr.nombre,
    protocoloVersion: pr.version,
    pagadorId: pagadorId ?? null,
    precioPaquete,
    totalLista,
    total: precioPaquete ?? totalLista,
    partidas: lineas as unknown as Prisma.InputJsonValue,
  };
}

/** Los datos de una versión nueva a partir de lo que se acaba de armar. */
export async function datosDeVersion(
  db: Db,
  companyId: string,
  numero: number,
  lista: { partidas: PartidaArmada[] },
  armado: { subtotal: number; iva: number; total: number },
  precioPaquete: number | null,
  quien: { id: string; name?: string | null; email?: string | null },
  motivo?: string | null,
) {
  const lineas = await lineasDeArmado(db, companyId, lista.partidas);
  return {
    numero,
    userId: quien.id,
    userNombre: quien.name ?? quien.email ?? null,
    motivo: motivo?.trim() || null,
    precioPaquete,
    totalLista: totalLineas(lineas),
    subtotal: armado.subtotal,
    iva: armado.iva,
    total: armado.total,
    partidas: lineas as unknown as Prisma.InputJsonValue,
  };
}

type OrigenRow = {
  protocoloId: string | null; protocoloClave: string | null; protocoloNombre: string; protocoloVersion: number | null;
  pagadorId: string | null; precioPaquete: unknown; totalLista: unknown; total: unknown; partidas: unknown; createdAt: Date;
};
type VersionRow = {
  numero: number; createdAt: Date; userNombre: string | null; motivo: string | null; reconstruida: boolean;
  precioPaquete: unknown; totalLista: unknown; total: unknown; partidas: unknown;
};

export interface HistoriaCotizacion {
  origen: null | {
    protocoloId: string | null; protocoloClave: string | null; protocoloNombre: string; protocoloVersion: number | null;
    precioPaquete: number | null; totalLista: number; total: number; lineas: LineaHistoria[]; createdAt: Date;
  };
  versiones: Array<{
    numero: number; createdAt: Date; userNombre: string | null; motivo: string | null; reconstruida: boolean;
    precioPaquete: number | null; total: number; totalLista: number;
    /** Contra la versión anterior (null en la primera). */
    cambios: Comparacion | null;
  }>;
  /** Origen contra la última versión; null sin origen o sin versiones. */
  comparacion: Comparacion | null;
}

/** Origen y versiones comparados, listos para la pantalla. */
export function historiaDeCotizacion(origen: OrigenRow | null, versiones: VersionRow[]): HistoriaCotizacion {
  const vs = [...versiones].sort((a, b) => a.numero - b.numero).map((v) => ({
    numero: v.numero, createdAt: v.createdAt, userNombre: v.userNombre, motivo: v.motivo, reconstruida: v.reconstruida,
    precioPaquete: v.precioPaquete == null ? null : Number(v.precioPaquete),
    total: Number(v.total), totalLista: Number(v.totalLista), lineas: lineasDeJson(v.partidas),
  }));
  const o = origen
    ? {
        protocoloId: origen.protocoloId, protocoloClave: origen.protocoloClave, protocoloNombre: origen.protocoloNombre, protocoloVersion: origen.protocoloVersion,
        precioPaquete: origen.precioPaquete == null ? null : Number(origen.precioPaquete),
        totalLista: Number(origen.totalLista), total: Number(origen.total), lineas: lineasDeJson(origen.partidas), createdAt: origen.createdAt,
      }
    : null;
  const ultima = vs.at(-1);
  return {
    origen: o,
    versiones: vs.map((v, i) => ({
      numero: v.numero, createdAt: v.createdAt, userNombre: v.userNombre, motivo: v.motivo, reconstruida: v.reconstruida,
      precioPaquete: v.precioPaquete, total: v.total, totalLista: v.totalLista,
      cambios: i === 0 ? null : compararCotizacion({ lineas: vs[i - 1].lineas, total: vs[i - 1].total }, { lineas: v.lineas, total: v.total }),
    })),
    comparacion: o && ultima ? compararCotizacion({ lineas: o.lineas, total: o.total }, { lineas: ultima.lineas, total: ultima.total }) : null,
  };
}
