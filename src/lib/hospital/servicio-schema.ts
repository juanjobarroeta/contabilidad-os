import { z } from "zod";
import { dinero, tasaIva } from "./http";

export const CATEGORIAS_CARGO = ["HABITACION", "QUIROFANO", "URGENCIAS", "ESTUDIO", "PROCEDIMIENTO", "HONORARIO", "FARMACIA", "MATERIAL", "EQUIPO", "OTRO"] as const;

/** Campos del servicio del tarifario (POST /servicios y PATCH /servicios/[id]). */
export const servicioSchema = z.object({
  clave: z.string().min(1).max(40),
  nombre: z.string().min(1).max(200),
  categoria: z.enum(CATEGORIAS_CARGO),
  unidad: z.string().max(30).optional(),
  precioLista: dinero,
  /** undefined = default por categoría (config.ivaServicios / exento / 0 %). */
  ivaTasa: tasaIva.optional(),
  claveProdServ: z.string().max(10).nullable().optional(),
  claveUnidad: z.string().max(5).nullable().optional(),
  activo: z.boolean().optional(),
});

export const tarifasSchema = z.object({
  tarifas: z.array(z.object({ pagadorId: z.string().min(1), precio: dinero.nullable() })).max(200),
});

export const serializarServicio = <T extends { precioLista: unknown; ivaTasa: unknown; tarifas?: Array<{ precio: unknown } & Record<string, unknown>> }>(s: T) => ({
  ...s,
  precioLista: Number(s.precioLista),
  ivaTasa: s.ivaTasa == null ? null : Number(s.ivaTasa),
  tarifas: (s.tarifas ?? []).map((t) => ({ ...t, precio: Number(t.precio) })),
});
