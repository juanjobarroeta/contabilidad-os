import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Campos de la RECEPCIÓN física de la unidad (checkup) — compartidos entre el
// create/patch de órdenes y el recibir de citas, para que las tres puertas
// acepten exactamente lo mismo. `firmadoAt` NO está aquí a propósito: sólo lo
// fija el servidor al subir el CONTRATO_FIRMADO (ordenes/[id]/documentos).
// ─────────────────────────────────────────────────────────────────────────────

export const inventarioRecepcionSchema = z.object({
  items: z
    .array(
      z.object({
        clave: z.string().min(1).max(40),
        etiqueta: z.string().min(1).max(80),
        ok: z.boolean(),
      })
    )
    .max(40),
  pertenencias: z.string().max(1000).optional(),
  comentarios: z.string().max(2000).optional(),
});

export const camposRecepcion = {
  torre: z.string().max(20).nullable().optional(),
  gasolinaOctavos: z.number().int().min(0).max(8).nullable().optional(),
  inventarioRecepcion: inventarioRecepcionSchema.nullable().optional(),
  garantiaDias: z.number().int().min(0).max(3650).nullable().optional(),
} as const;

/** Los mismos campos, listos para regarse en un create/update de Prisma. */
export function datosRecepcion(d: {
  torre?: string | null;
  gasolinaOctavos?: number | null;
  inventarioRecepcion?: z.infer<typeof inventarioRecepcionSchema> | null;
  garantiaDias?: number | null;
}) {
  return {
    ...(d.torre !== undefined ? { torre: d.torre?.trim().toUpperCase() || null } : {}),
    ...(d.gasolinaOctavos !== undefined ? { gasolinaOctavos: d.gasolinaOctavos } : {}),
    ...(d.inventarioRecepcion !== undefined
      ? { inventarioRecepcion: d.inventarioRecepcion ?? undefined }
      : {}),
    ...(d.garantiaDias !== undefined ? { garantiaDias: d.garantiaDias } : {}),
  };
}
