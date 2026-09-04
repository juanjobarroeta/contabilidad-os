import { z } from "zod";

/** Campos editables de un médico (POST /medicos y PATCH /medicos/[id]). */
export const medicoSchema = z.object({
  nombre: z.string().min(1).max(120),
  especialidad: z.string().max(80).nullable().optional(),
  cedula: z.string().max(20).nullable().optional(),
  rfc: z.string().max(13).nullable().optional(),
  telefono: z.string().max(30).nullable().optional(),
  email: z.string().email().max(120).nullable().optional(),
  supplierId: z.string().nullable().optional(),
  employeeId: z.string().nullable().optional(),
  activo: z.boolean().optional(),
});
