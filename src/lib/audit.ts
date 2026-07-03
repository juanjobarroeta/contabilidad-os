// Bitácora de seguridad (append-only). Registra eventos sensibles en la tabla
// AuditLog: timbrado/cancelación de CFDI, dispersión de nómina, cambios de
// credenciales, gestión de miembros, acciones confirmadas del asistente y
// bajas de empresa/cuenta.
//
// REGLA DE ORO — NUNCA guardar secretos en `detalle`: ni contraseñas, ni
// llaves privadas (.key), ni certificados, ni tokens ni API keys. Sólo
// metadatos: RFC, totales, UUID fiscales, motivos, conteos, nombres de campo.
//
// El registro es "fire-and-forget": registrarBitacora nunca lanza y nunca
// bloquea la respuesta. Si el insert falla, se loguea a consola y la petición
// del usuario sigue su curso — la bitácora jamás debe tirar una operación.
import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";

export type EntradaBitacora = {
  companyId?: string | null;
  userId?: string | null;
  actorEmail?: string | null;
  /** Acción corta en kebab-case con prefijo de dominio, p. ej. "factura.timbrar". */
  accion: string;
  /** Nombre del modelo afectado, p. ej. "Invoice". */
  entidad?: string | null;
  entidadId?: string | null;
  /** SOLO metadatos (RFC, total, uuid, motivo...). Nunca secretos. */
  detalle?: Prisma.InputJsonValue | null;
  ip?: string | null;
  /**
   * Si se pasa el Request y no se dio `ip`, se toma la IP del encabezado
   * x-forwarded-for (primer salto).
   */
  req?: Request | null;
};

/** Extrae la IP del cliente del encabezado x-forwarded-for (primer salto). */
export function ipDeRequest(req: Request | null | undefined): string | null {
  try {
    const xff = req?.headers?.get?.("x-forwarded-for");
    if (!xff) return null;
    const first = xff.split(",")[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Inserta una fila en la bitácora de seguridad. Fire-and-forget:
 *   - NUNCA lanza (errores se loguean con prefijo [bitacora]).
 *   - NO bloquea: no hace falta await; el insert corre en segundo plano.
 */
export function registrarBitacora(entrada: EntradaBitacora): void {
  try {
    const { req, ip, detalle, ...resto } = entrada;
    void prisma.auditLog
      .create({
        data: {
          companyId: resto.companyId ?? null,
          userId: resto.userId ?? null,
          actorEmail: resto.actorEmail ?? null,
          accion: resto.accion,
          entidad: resto.entidad ?? null,
          entidadId: resto.entidadId ?? null,
          detalle: detalle ?? undefined,
          ip: ip ?? ipDeRequest(req),
        },
      })
      .catch((e) => {
        console.error(`[bitacora] no se pudo registrar "${entrada.accion}":`, e);
      });
  } catch (e) {
    // Defensa extra: ni siquiera un error síncrono debe escapar.
    console.error(`[bitacora] error inesperado registrando "${entrada.accion}":`, e);
  }
}
