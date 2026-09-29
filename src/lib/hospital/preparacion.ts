import type { Prisma } from "@prisma/client";
import { HospitalError } from "./errores";

export async function exigirPreparacionQuirurgica(db: Prisma.TransactionClient, companyId: string, episodioId: string) {
  // A prior operation cannot authorize a second procedure in the same encounter.
  const priorEntry = await db.hospControlEvento.findFirst({ where: { companyId, referencia: episodioId, tipo: "INGRESO_QUIROFANO" }, orderBy: { createdAt: "desc" } });
  const since = new Date(Math.max(Date.now() - 2 * 3600_000, priorEntry ? priorEntry.createdAt.getTime() + 1 : 0));
  await db.$executeRaw`SELECT id FROM "HospDocumento" WHERE "episodioId" = ${episodioId} FOR SHARE`;
  const [docs, events] = await Promise.all([
    db.hospDocumento.findMany({ where: { episodioId }, select: { tipo: true, estado: true, firmadoAt: true } }),
    db.hospControlEvento.findMany({ where: { companyId, referencia: episodioId, tipo: { in: ["PREPARACION", "URGENCIA_QUIRURGICA"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } }),
  ]);
  const faltan = ["CONSENTIMIENTO_CIRUGIA", "CONSENTIMIENTO_ANESTESIA"].filter(tipo => !docs.some(d => d.tipo === tipo && d.estado === "FIRMADO" && d.firmadoAt));
  const checklist = events.find(e => e.tipo === "PREPARACION");
  if (!checklist) faltan.push("VERIFICACION_IDENTIDAD_PROCEDIMIENTO_ALERGIAS");
  if (!faltan.length) return { modalidad: "ORDINARIA", faltantes: [], evidencias: [checklist!.id] };
  // Each physician attests from their own authenticated, verified account.
  const groups = new Map<string, typeof events>();
  for (const e of events.filter(e => e.tipo === "URGENCIA_QUIRURGICA")) {
    const d = e.datos as Record<string, unknown>;
    if (typeof d.solicitudId !== "string") continue;
    groups.set(d.solicitudId, [...(groups.get(d.solicitudId) ?? []), e]);
  }
  for (const group of groups.values()) {
    const ids = [...new Set(group.map(e => e.actorId))];
    const verified = await db.hospMedico.count({ where: { companyId, userId: { in: ids }, activo: true, credencialVerificadaAt: { not: null } } });
    if (verified >= 2) return { modalidad: "URGENCIA", faltantes: faltan, evidencias: group.map(e => e.id) };
  }
  throw new HospitalError(409, `Preparación incompleta: ${faltan.join(", ")}. En urgencia documenta la excepción con dos médicos autorizados.`);
}
