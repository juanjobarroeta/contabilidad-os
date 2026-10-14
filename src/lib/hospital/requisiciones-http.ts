// Esquema de captura de una requisición y los nombres de usuario que las
// pantallas enseñan (quién pidió, quién autorizó). Compartido por las rutas.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { fechaSchema } from "./http";

export const requisicionSchema = z.object({
  companyId: z.string().min(1),
  /** Un solo proveedor (precios en las partidas). Con `cotizaciones` no se usa. */
  supplierId: z.string().min(1, "Elige el proveedor (o dalo de alta)").nullable().optional(),
  area: z.string().trim().max(80).nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
  fechaEntrega: fechaSchema.nullable().optional(),
  partidas: z
    .array(
      z.object({
        hospInsumoId: z.string().min(1).nullable().optional(),
        descripcion: z.string().trim().min(1).max(300),
        unidad: z.string().trim().max(20).nullable().optional(),
        cantidad: z.number().positive().max(10_000_000),
        precioUnitario: z.number().min(0).max(100_000_000),
        lineaAreaId: z.string().min(1).nullable().optional(),
      })
    )
    .min(1, "Agrega al menos una línea"),
  /** Varias ofertas: precio por partida en el mismo orden (null = no la cotizó). */
  cotizaciones: z
    .array(
      z.object({
        supplierId: z.string().min(1, "Elige el proveedor de cada cotización"),
        tieneCredito: z.boolean().nullable().optional(),
        diasCredito: z.number().int().min(0).max(365).nullable().optional(),
        diasEntrega: z.number().int().min(0).max(365).nullable().optional(),
        vigenciaHasta: fechaSchema.nullable().optional(),
        notas: z.string().trim().max(1000).nullable().optional(),
        precios: z.array(z.number().min(0).max(100_000_000).nullable()),
      })
    )
    .max(10)
    .nullable()
    .optional(),
  ganadoras: z.array(z.number().int().min(0).nullable()).nullable().optional(),
})
  .refine((d) => !!d.supplierId || !!d.cotizaciones?.length, { message: "Elige el proveedor (o captura las cotizaciones)", path: ["supplierId"] });

/** Fechas de la captura a Date para el motor. */
export function aRequisicionInput(d: z.infer<typeof requisicionSchema>) {
  return {
    ...d,
    fechaEntrega: d.fechaEntrega ? new Date(d.fechaEntrega) : null,
    cotizaciones: d.cotizaciones?.map((c) => ({ ...c, vigenciaHasta: c.vigenciaHasta ? new Date(c.vigenciaHasta) : null })) ?? null,
  };
}

export async function nombresDeUsuarios(ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const unicos = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unicos.length) return {};
  const users = await prisma.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, email: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name ?? u.email ?? u.id]));
}
