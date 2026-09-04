// Cotización con el tarifario del pagador: precio de cada partida desde
// HospTarifa (o lista), IVA por categoría, totales calculados aquí — nunca
// los que mande el cliente. Compartido por POST /cotizaciones y PATCH
// (action "partidas").

import { z } from "zod";
import type { HospCargoCategoria, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { dinero, tasaIva } from "./http";
import { ivaDefault, r2 } from "./util";
import { CATEGORIAS_CARGO } from "./servicio-schema";

type Db = PrismaClient | Prisma.TransactionClient;

export const partidaSchema = z.object({
  servicioId: z.string().nullable().optional(),
  categoria: z.enum(CATEGORIAS_CARGO).optional(),
  descripcion: z.string().min(1).max(300).optional(),
  cantidad: z.number().positive().max(100000).default(1),
  precioUnitario: dinero.optional(),
  /** undefined = la tasa del servicio o el default por categoría. */
  ivaTasa: tasaIva.optional(),
});

export type PartidaEntrada = z.infer<typeof partidaSchema>;

export interface PartidaArmada {
  orden: number;
  servicioId: string | null;
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  ivaTasa: number | null;
  importe: number;
}

export async function armarPartidas(
  db: Db,
  companyId: string,
  pagadorId: string | null | undefined,
  entradas: PartidaEntrada[]
): Promise<{ partidas: PartidaArmada[]; subtotal: number; iva: number; total: number }> {
  const ids = [...new Set(entradas.map((p) => p.servicioId).filter(Boolean))] as string[];
  const servicios = ids.length
    ? await db.hospServicio.findMany({
        where: { id: { in: ids }, companyId },
        include: { tarifas: pagadorId ? { where: { pagadorId } } : false },
      })
    : [];
  const porId = new Map(servicios.map((s) => [s.id, s]));
  const config = await db.hospConfig.findUnique({ where: { companyId }, select: { ivaServicios: true } });
  const ivaServicios = config ? Number(config.ivaServicios) : null;

  const partidas: PartidaArmada[] = entradas.map((p, i) => {
    const servicio = p.servicioId ? porId.get(p.servicioId) : null;
    if (p.servicioId && !servicio) throw new HospitalError(400, `servicioId inválido en la partida ${i + 1}`);
    const tarifa = servicio && Array.isArray(servicio.tarifas) ? servicio.tarifas[0] : null;
    const categoria = p.categoria ?? servicio?.categoria;
    const descripcion = p.descripcion?.trim() || servicio?.nombre;
    const precioUnitario = p.precioUnitario ?? (servicio ? r2(Number(tarifa?.precio ?? servicio.precioLista)) : undefined);
    if (!categoria || !descripcion || precioUnitario == null) {
      throw new HospitalError(400, `La partida ${i + 1} necesita servicioId o (categoria, descripcion, precioUnitario)`);
    }
    const ivaTasa =
      p.ivaTasa !== undefined ? p.ivaTasa : servicio ? (servicio.ivaTasa == null ? null : Number(servicio.ivaTasa)) : ivaDefault(categoria, ivaServicios);
    return {
      orden: i,
      servicioId: servicio?.id ?? null,
      categoria,
      descripcion,
      cantidad: p.cantidad,
      precioUnitario,
      ivaTasa,
      importe: r2(p.cantidad * precioUnitario),
    };
  });

  const subtotal = r2(partidas.reduce((s, p) => s + p.importe, 0));
  const iva = r2(partidas.reduce((s, p) => s + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));
  return { partidas, subtotal, iva, total: r2(subtotal + iva) };
}

export const incluyeCotizacion = {
  paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, fechaNacimiento: true } },
  pagador: { select: { id: true, nombre: true, tipo: true, tabulador: true } },
  episodio: { select: { id: true, folio: true, estado: true } },
  partidas: { orderBy: { orden: "asc" as const }, include: { servicio: { select: { id: true, clave: true, nombre: true } } } },
} as const;

export function serializarCotizacion<
  T extends {
    subtotal: unknown;
    iva: unknown;
    total: unknown;
    partidas?: Array<{ cantidad: unknown; precioUnitario: unknown; ivaTasa: unknown; importe: unknown } & Record<string, unknown>>;
  },
>(c: T) {
  return {
    ...c,
    subtotal: Number(c.subtotal),
    iva: Number(c.iva),
    total: Number(c.total),
    partidas: (c.partidas ?? []).map((p) => {
      const importe = Number(p.importe);
      const ivaTasa = p.ivaTasa == null ? null : Number(p.ivaTasa);
      const iva = ivaTasa == null ? 0 : r2(importe * ivaTasa);
      return { ...p, cantidad: Number(p.cantidad), precioUnitario: Number(p.precioUnitario), ivaTasa, importe, iva, total: r2(importe + iva) };
    }),
  };
}
