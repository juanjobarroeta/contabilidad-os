// Registro y consulta de aceptaciones de documentos legales (LegalAcceptance).
//
// A diferencia de la bitácora (fire-and-forget), aquí el insert SÍ se espera:
// la aceptación es condición del flujo (crear cuenta, guardar e.firma), y si
// no se pudo guardar la evidencia el flujo debe fallar, no seguir a ciegas.
import type { LegalDocumento, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ipDeRequest } from "@/lib/audit";
import {
  DOCUMENTOS_CUENTA,
  MANDATO_EFIRMA,
  documentosPendientes,
  versionVigente,
  type DocumentoLegal,
} from "./documentos";

export type ContextoAceptacion = "signup" | "gate" | "onboarding" | "configuracion";

type Cliente = Prisma.TransactionClient | typeof prisma;

function userAgentDeRequest(req: Request | null | undefined): string | null {
  const ua = req?.headers?.get?.("user-agent");
  return ua ? ua.slice(0, 500) : null;
}

/**
 * Inserta una aceptación por documento, con la versión vigente de cada uno.
 * Acepta un TransactionClient para que la evidencia quede en la misma
 * transacción que la creación del usuario/empresa.
 */
export async function registrarAceptaciones(
  params: {
    userId: string;
    email?: string | null;
    companyId?: string | null;
    documentos: readonly LegalDocumento[];
    contexto: ContextoAceptacion;
    req?: Request | null;
  },
  db: Cliente = prisma
): Promise<void> {
  if (params.documentos.length === 0) return;
  const ip = ipDeRequest(params.req);
  const userAgent = userAgentDeRequest(params.req);
  await db.legalAcceptance.createMany({
    data: params.documentos.map((documento) => ({
      userId: params.userId,
      email: params.email ?? null,
      companyId: params.companyId ?? null,
      documento,
      version: versionVigente(documento),
      contexto: params.contexto,
      ip,
      userAgent,
    })),
  });
}

/** Documentos de cuenta (Términos, Aviso) que el usuario aún debe aceptar. */
export async function pendientesDeUsuario(userId: string): Promise<DocumentoLegal[]> {
  const filas = await prisma.legalAcceptance.findMany({
    where: { userId, documento: { in: DOCUMENTOS_CUENTA.map((d) => d.documento) } },
    select: { documento: true, version: true },
  });
  return documentosPendientes(filas);
}

/**
 * ¿La e.firma de esta empresa tiene una autorización vigente por parte de
 * alguien? (Consulta informativa: la aceptación se exige en el momento de
 * cargar la e.firma, no aquí.)
 */
export async function mandatoEfirmaVigente(companyId: string): Promise<boolean> {
  const fila = await prisma.legalAcceptance.findFirst({
    where: { companyId, documento: "MANDATO_EFIRMA", version: MANDATO_EFIRMA.version },
    select: { id: true },
  });
  return !!fila;
}
