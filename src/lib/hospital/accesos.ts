// ─────────────────────────────────────────────────────────────────────────────
// Bitácora de ACCESOS al expediente (NOM-024-SSA3-2012 y LFPDPPP).
//
// AuditLog ya lleva las escrituras; esto registra las LECTURAS: quién abrió
// qué expediente, ficha o cuenta, cuándo y desde dónde, y las salidas del
// sistema. La lectura sólo se entrega después de persistir la bitácora.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospAccesoAccion } from "@prisma/client";
import { AuthzError } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ipDeRequest } from "@/lib/audit";

export const ACCIONES_ACCESO: readonly HospAccesoAccion[] = ["LECTURA_EXPEDIENTE", "LECTURA_CUENTA", "LECTURA_FICHA", "EXPORTACION", "IMPRESION", "CONSULTA_RENAPO"];

export interface RegistrarAccesoArgs {
  companyId: string;
  accion: HospAccesoAccion;
  episodioId?: string | null;
  pacienteId?: string | null;
  /** Qué se leyó o exportó, en una línea: «Expediente HOSP-2026-0418». */
  detalle?: string | null;
  /** El usuario autenticado (withAuthz). Sin usuario = proceso del sistema. */
  user?: { id?: string | null; email?: string | null } | null;
  /** Para tomar la IP del encabezado x-forwarded-for. */
  req?: Request | null;
  ip?: string | null;
}

export async function registrarAcceso(args: RegistrarAccesoArgs): Promise<void> {
  try {
    await prisma.hospAcceso.create({ data: {
      companyId: args.companyId, episodioId: args.episodioId ?? null,
      pacienteId: args.pacienteId ?? null, userId: args.user?.id ?? null,
      userEmail: args.user?.email ?? null, accion: args.accion,
      detalle: args.detalle ?? null, ip: args.ip ?? ipDeRequest(args.req),
    } });
  } catch {
    console.error("[hospital.acceso] audit persistence failed", { accion: args.accion });
    throw new AuthzError(503, "No se pudo registrar el acceso. Reintenta cuando se restablezca la bitácora.");
  }
}

/** Fila de HospAcceso como la enseña el satélite (más reciente primero). */
export function accesoResumen(a: {
  id: string;
  at: Date;
  accion: HospAccesoAccion;
  detalle: string | null;
  userId: string | null;
  userEmail: string | null;
  ip: string | null;
  episodioId: string | null;
  pacienteId: string | null;
}) {
  return {
    id: a.id,
    at: a.at,
    accion: a.accion,
    detalle: a.detalle,
    userId: a.userId,
    userEmail: a.userEmail,
    ip: a.ip,
    episodioId: a.episodioId,
    pacienteId: a.pacienteId,
  };
}
