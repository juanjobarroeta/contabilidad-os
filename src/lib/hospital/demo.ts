import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const DEMO_CEDULA = "DEMO";
export const DEMO_LEYENDA = "DEMOSTRACIÓN — DATOS FICTICIOS — SIN VALIDEZ CLÍNICA";
const grantSchema = z.object({ habilitado: z.literal(true), medicoId: z.string().min(1), pacienteIds: z.array(z.string().min(1)).min(1) });

// These event types are provisioned by an audited operator script, never by
// a public hospital endpoint. The latest event also supports explicit revocation.
export async function demoMedicalGrant(companyId: string, userId: string) {
  const event = await prisma.hospControlEvento.findFirst({
    where: { companyId, tipo: "DEMO_MEDICO_ACCESO", referencia: userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const result = grantSchema.safeParse(event?.datos);
  return result.success ? result.data : null;
}

export async function isDemoPatient(companyId: string, pacienteId: string) {
  const [patient, event] = await Promise.all([
    prisma.hospPaciente.findFirst({ where: { id: pacienteId, companyId }, select: { id: true } }),
    prisma.hospControlEvento.findFirst({
      where: { companyId, tipo: "DEMO_PACIENTE", referencia: pacienteId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return Boolean(patient && z.object({ habilitado: z.literal(true) }).safeParse(event?.datos).success);
}

export function demoText(text: string, demo: boolean) {
  return demo ? `${DEMO_LEYENDA}\n\n${text}` : text;
}
