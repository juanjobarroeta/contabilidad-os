// Esquema de captura de una requisición y los nombres de usuario que las
// pantallas enseñan (quién pidió, quién autorizó). Compartido por las rutas.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { fechaSchema } from "./http";

export const requisicionSchema = z.object({
  companyId: z.string().min(1),
  supplierId: z.string().min(1, "Elige el proveedor (o dalo de alta)"),
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
      })
    )
    .min(1, "Agrega al menos una línea"),
});

export async function nombresDeUsuarios(ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const unicos = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unicos.length) return {};
  const users = await prisma.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, email: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name ?? u.email ?? u.id]));
}
