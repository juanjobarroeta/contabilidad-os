import { z } from "zod";

/** Datos de un trabajador de obra (alta y edición). */
export const trabajadorSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  telefono: z.string().trim().max(30).nullable().optional(),
  especialidad: z.string().trim().max(60).nullable().optional(),
  tipoPago: z.enum(["DIA", "HORA"]),
  // Jornal por día o pago por hora, según tipoPago.
  tarifa: z.number().positive().max(100000),
  horasJornada: z.number().positive().max(24).optional(),
  employeeId: z.string().min(1).nullable().optional(),
});

export const trabajadorUpdateSchema = trabajadorSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });
