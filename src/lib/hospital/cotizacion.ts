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
  /** Concepto mencionado sin precio («No cotizado»): importe 0, fuera del total. */
  sinCotizar: z.boolean().optional(),
  /** Descuento interno de la partida (%): baja el precio, pero la cotización
   *  impresa sólo enseña el precio ya descontado. */
  descuentoPct: z.number().min(0).max(100).optional(),
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
  sinCotizar?: boolean;
  /** Sólo con descuento: el % y el precio antes de él (precioUnitario ya es el neto). */
  descuentoPct?: number;
  precioSinDescuento?: number;
}

/** Precio unitario neto: el base menos el descuento (6 decimales, como se guarda). */
export function precioConDescuento(base: number, descuentoPct: number | null | undefined): number {
  if (!descuentoPct) return base;
  return Math.round(base * (1 - descuentoPct / 100) * 1e6) / 1e6;
}

export async function armarPartidas(
  db: Db,
  companyId: string,
  pagadorId: string | null | undefined,
  entradas: PartidaEntrada[]
): Promise<{ partidas: PartidaArmada[]; subtotal: number; iva: number; total: number; preciosMovidos: number[] }> {
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

  // Partidas (1-based) cuyo precio no es el del tarifario/lista: capturado a
  // mano, sin servicio o con descuento. Sólo COTIZACION_PRECIOS las guarda.
  const preciosMovidos: number[] = [];
  const partidas: PartidaArmada[] = entradas.map((p, i) => {
    const servicio = p.servicioId ? porId.get(p.servicioId) : null;
    if (p.servicioId && !servicio) throw new HospitalError(400, `servicioId inválido en la partida ${i + 1}`);
    const tarifa = servicio && Array.isArray(servicio.tarifas) ? servicio.tarifas[0] : null;
    const categoria = p.categoria ?? servicio?.categoria;
    const descripcion = p.descripcion?.trim() || servicio?.nombre;
    const base = p.sinCotizar ? 0 : p.precioUnitario ?? (servicio ? r2(Number(tarifa?.precio ?? servicio.precioLista)) : undefined);
    if (!categoria || !descripcion || base == null) {
      throw new HospitalError(400, `La partida ${i + 1} necesita servicioId o (categoria, descripcion, precioUnitario)`);
    }
    const descuento = !p.sinCotizar && p.descuentoPct && base > 0 ? p.descuentoPct : 0;
    if (!p.sinCotizar) {
      const delTarifario = servicio ? r2(Number(tarifa?.precio ?? servicio.precioLista)) : null;
      const capturado = p.precioUnitario != null && (delTarifario == null ? p.precioUnitario > 0 : Math.abs(p.precioUnitario - delTarifario) >= 0.005);
      if (capturado || descuento) preciosMovidos.push(i + 1);
    }
    const precioUnitario = precioConDescuento(base, descuento);
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
      sinCotizar: p.sinCotizar ?? false,
      ...(descuento ? { descuentoPct: descuento, precioSinDescuento: base } : {}),
    };
  });

  const subtotal = r2(partidas.reduce((s, p) => s + p.importe, 0));
  const iva = r2(partidas.reduce((s, p) => s + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));
  return { partidas, subtotal, iva, total: r2(subtotal + iva), preciosMovidos };
}

export const PERMISO_PRECIOS = "COTIZACION_PRECIOS" as const;

export function mensajePreciosMovidos(lineas: number[]): string {
  return `Sólo quien tiene «Cambiar precios en cotizaciones» mueve precios o da descuentos (partida${lineas.length === 1 ? "" : "s"} ${lineas.join(", ")}). Usa el precio del tarifario o pide que la ajuste quien tenga el permiso.`;
}

/**
 * Paquete: el hospital pacta un TOTAL CON IVA y las partidas se prorratean a
 * ese total (mismo peso que tenían a precio de lista), así la conversión a
 * cuenta y el IVA por categoría siguen cuadrando. Los centavos que sobren del
 * redondeo se cargan a la partida más grande. Lanza 400 si ninguna partida
 * tiene precio: no hay con qué repartir.
 */
export function aPaquete(
  armado: { partidas: PartidaArmada[]; subtotal: number; iva: number; total: number; preciosMovidos?: number[] },
  precioPaquete: number
): { partidas: PartidaArmada[]; subtotal: number; iva: number; total: number } {
  if (!(precioPaquete > 0)) throw new HospitalError(400, "El precio del paquete debe ser mayor a cero");
  if (!(armado.total > 0)) throw new HospitalError(400, "Para cotizar en paquete al menos una partida debe tener precio (del tarifario o capturado)");
  const factor = precioPaquete / armado.total;
  const conIva = (p: PartidaArmada) => p.importe * (1 + (p.ivaTasa ?? 0));
  // En paquete el total pactado manda: el descuento por partida ya no aplica.
  const partidas = armado.partidas.map(({ descuentoPct: _d, precioSinDescuento: _b, ...p }) => {
    const importe = r2(p.importe * factor);
    return { ...p, importe, precioUnitario: p.cantidad > 0 ? Math.round((importe / p.cantidad) * 1e6) / 1e6 : 0 };
  });
  const totalDe = (ps: PartidaArmada[]) => r2(ps.reduce((s, p) => s + p.importe + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));
  const residuo = r2(precioPaquete - totalDe(partidas));
  if (Math.abs(residuo) >= 0.005) {
    const mayor = partidas.reduce((a, b) => (conIva(b) > conIva(a) ? b : a));
    const ajuste = r2(residuo / (1 + (mayor.ivaTasa ?? 0)));
    mayor.importe = r2(mayor.importe + ajuste);
    mayor.precioUnitario = mayor.cantidad > 0 ? Math.round((mayor.importe / mayor.cantidad) * 1e6) / 1e6 : 0;
  }
  const subtotal = r2(partidas.reduce((s, p) => s + p.importe, 0));
  const total = r2(precioPaquete);
  // El total pactado manda; el IVA es lo que falta para llegar a él.
  return { partidas, subtotal, iva: r2(total - subtotal), total };
}

export const incluyeCotizacion = {
  medico: { select: { id: true, nombre: true, especialidad: true } },
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
    precioPaquete?: unknown;
    partidas?: Array<{ cantidad: unknown; precioUnitario: unknown; ivaTasa: unknown; importe: unknown; descuentoPct?: unknown; precioSinDescuento?: unknown } & Record<string, unknown>>;
  },
>(c: T) {
  return {
    ...c,
    subtotal: Number(c.subtotal),
    iva: Number(c.iva),
    total: Number(c.total),
    precioPaquete: c.precioPaquete == null ? null : Number(c.precioPaquete),
    partidas: (c.partidas ?? []).map((p) => {
      const importe = Number(p.importe);
      const ivaTasa = p.ivaTasa == null ? null : Number(p.ivaTasa);
      const iva = ivaTasa == null ? 0 : r2(importe * ivaTasa);
      return {
        ...p,
        cantidad: Number(p.cantidad),
        precioUnitario: Number(p.precioUnitario),
        descuentoPct: p.descuentoPct == null ? null : Number(p.descuentoPct),
        precioSinDescuento: p.precioSinDescuento == null ? null : Number(p.precioSinDescuento),
        ivaTasa,
        importe,
        iva,
        total: r2(importe + iva),
      };
    }),
  };
}
