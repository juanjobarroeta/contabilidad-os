// Esquema y validación de vínculos del paciente, compartidos por POST
// /pacientes y PATCH /pacientes/[id]. Viven fuera de route.ts porque Next no
// admite exports ajenos a los handlers en un archivo de ruta.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { fechaSchema } from "./http";

export const pacienteSchema = z.object({
  nombre: z.string().min(1).max(120),
  apellidoPaterno: z.string().min(1).max(120),
  apellidoMaterno: z.string().max(120).nullable().optional(),
  fechaNacimiento: fechaSchema.nullable().optional(),
  sexo: z.enum(["FEMENINO", "MASCULINO", "OTRO"]).nullable().optional(),
  curp: z.string().max(18).nullable().optional(),
  telefono: z.string().max(30).nullable().optional(),
  email: z.string().email().max(120).nullable().optional(),
  domicilio: z.string().max(300).nullable().optional(),
  tipoSangre: z.string().max(5).nullable().optional(),
  alergias: z.string().max(500).nullable().optional(),
  antecedentes: z.string().max(4000).nullable().optional(),
  contactoEmergenciaNombre: z.string().max(120).nullable().optional(),
  contactoEmergenciaTelefono: z.string().max(30).nullable().optional(),
  contactoEmergenciaParentesco: z.string().max(60).nullable().optional(),
  customerId: z.string().nullable().optional(),
  pagadorId: z.string().nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  activo: z.boolean().optional(),
});

/** Los FK canónicos deben ser de la misma empresa (fail-closed). */
export async function validarVinculosPaciente(
  companyId: string,
  d: { customerId?: string | null; pagadorId?: string | null }
): Promise<string | null> {
  if (d.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { companyId: true } });
    if (!c || c.companyId !== companyId) return "customerId inválido";
  }
  if (d.pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: d.pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== companyId) return "pagadorId inválido";
  }
  return null;
}
