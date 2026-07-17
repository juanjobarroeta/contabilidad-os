// ─────────────────────────────────────────────────────────────────────────────
// Liberación de slots de Syntage. Syntage cobra/limita por RFC VINCULADO
// (credencial), así que un cliente que se dio de baja — o que dejó de pagar —
// sigue ocupando lugar del plan hasta que sus credenciales se borran de
// Syntage. Aquí viven:
//   • liberarSlotSyntage(rfc): borra TODAS las credenciales del RFC (y la
//     entidad, opcional). Mejor esfuerzo por elemento; nunca lanza.
//   • clasificarSlot(): decisión PURA de qué hacer con cada RFC vinculado
//     (la usa el cron syntage-liberar-slots; testeada sin red ni DB).
//
// Reversibilidad: la e.firma vive cifrada en nuestra DB, y el
// aprovisionamiento (provision.ts) es idempotente — si un cliente liberado
// vuelve a pagar, su credencial y extracciones se recrean solas en la
// siguiente corrida del cron. Liberar un slot nunca pierde nada permanente.
// ─────────────────────────────────────────────────────────────────────────────

import { SyntageClient } from "./client";

export interface LiberacionSlot {
  rfc: string;
  credencialesBorradas: number;
  entidadBorrada: boolean;
  errores: string[];
}

/**
 * Borra de Syntage todas las credenciales de un RFC (cualquier estado — una
 * credencial inválida también ocupa el slot) y, con `borrarEntidad`, la
 * entidad con su historial extraído (para bajas definitivas / LFPDPPP).
 * Mejor esfuerzo: los fallos por elemento se acumulan en `errores`.
 */
export async function liberarSlotSyntage(
  rfc: string,
  opts: { borrarEntidad?: boolean; client?: SyntageClient } = {}
): Promise<LiberacionSlot> {
  const out: LiberacionSlot = { rfc, credencialesBorradas: 0, entidadBorrada: false, errores: [] };
  let client: SyntageClient;
  try {
    client = opts.client ?? new SyntageClient();
  } catch (e) {
    out.errores.push(e instanceof Error ? e.message : String(e));
    return out;
  }

  try {
    const creds = await client.credencialesDeRfc(rfc);
    for (const c of creds) {
      try {
        await client.deleteCredential(c.id);
        out.credencialesBorradas++;
      } catch (e) {
        out.errores.push(`credencial ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    out.errores.push(`listado de credenciales: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (opts.borrarEntidad) {
    try {
      const ent = await client.findEntityByRfc(rfc);
      if (ent) {
        await client.deleteEntity(ent.id);
        out.entidadBorrada = true;
      }
    } catch (e) {
      out.errores.push(`entidad: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ── Clasificación pura de un RFC vinculado en Syntage ────────────────────────

export type EstadoEmpresaSlot = {
  /** ¿Existe una Company local con este RFC? */
  existe: boolean;
  /** ¿Conserva su e.firma guardada? (sin ella no puede extraer nada) */
  tieneFiel?: boolean;
  /** ¿Su tier incluye Syntage? (planIncluyeSyntage) */
  incluyeSyntage?: boolean;
  /** ¿Algún pagador (OWNER/ADMIN de empresa o despacho) sigue vigente? */
  pagoVigente?: boolean;
};

export type MotivoSlot = "activa" | "huerfana" | "sin_fiel" | "plan_sin_syntage" | "sin_pago";

export type AccionSlot = {
  accion: "conservar" | "liberar";
  motivo: MotivoSlot;
  /** Sólo las huérfanas (baja definitiva ya ejecutada) pierden también la entidad. */
  borrarEntidad: boolean;
};

/**
 * Decide qué hacer con el slot de un RFC vinculado en Syntage. Orden de las
 * reglas (la primera que aplica gana):
 *   huérfana (sin Company local)      → liberar credenciales + entidad
 *   sin e.firma guardada              → liberar credenciales
 *   tier sin Syntage (ASISTENTE)      → liberar credenciales
 *   sin ningún pagador vigente        → liberar credenciales
 *   lo demás                          → conservar
 */
export function clasificarSlot(e: EstadoEmpresaSlot): AccionSlot {
  if (!e.existe) return { accion: "liberar", motivo: "huerfana", borrarEntidad: true };
  if (!e.tieneFiel) return { accion: "liberar", motivo: "sin_fiel", borrarEntidad: false };
  if (!e.incluyeSyntage) return { accion: "liberar", motivo: "plan_sin_syntage", borrarEntidad: false };
  if (!e.pagoVigente) return { accion: "liberar", motivo: "sin_pago", borrarEntidad: false };
  return { accion: "conservar", motivo: "activa", borrarEntidad: false };
}
