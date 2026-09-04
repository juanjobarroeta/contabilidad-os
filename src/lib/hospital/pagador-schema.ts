import { z } from "zod";
import { dinero, fechaSchema } from "./http";

/** Campos del convenio (POST /pagadores y PATCH /pagadores/[id]). */
export const pagadorSchema = z.object({
  nombre: z.string().min(1).max(120),
  tipo: z.enum(["ASEGURADORA", "EMPRESA", "PARTICULAR", "GOBIERNO"]),
  customerId: z.string().nullable().optional(),
  tabulador: z.string().max(80).nullable().optional(),
  deducible: dinero.nullable().optional(),
  coaseguroPct: z.number().min(0).max(1).nullable().optional(),
  plazoDias: z.number().int().min(0).max(365).optional(),
  topeAutorizacion: dinero.nullable().optional(),
  vigenciaInicio: fechaSchema.nullable().optional(),
  vigenciaFin: fechaSchema.nullable().optional(),
  activo: z.boolean().optional(),
  notas: z.string().max(2000).nullable().optional(),
});
