import { z } from "zod";
import { validarCurp } from "./curp";
import { dividirNombre } from "./identidad";

/**
 * Campos editables de un médico (POST /medicos y PATCH /medicos/[id]).
 * P2 (SAEH exige CURP, nombre y apellidos separados del médico responsable):
 * `curp` validada localmente; `nombres`/`apellidoPaterno`/`apellidoMaterno`
 * explícitos o, si faltan, partidos de `nombre` («Dr. Alonso Vega») por
 * heurística sin pisar nunca lo que ya se capturó a mano.
 */
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
  curp: z.string().trim().max(18).nullable().optional(),
  nombres: z.string().trim().max(120).nullable().optional(),
  apellidoPaterno: z.string().trim().max(120).nullable().optional(),
  apellidoMaterno: z.string().trim().max(120).nullable().optional(),
  paisNacimientoClave: z.string().trim().regex(/^\d{1,3}$/, "Clave DGIS del país").nullable().optional(),
});

export type MedicoEntrada = z.infer<typeof medicoSchema>;

/** CURP del médico normalizada y validada (formato + dígito); null si viene vacía. */
export function resolverCurpMedico(curp: string | null | undefined): { ok: true; curp: string | null } | { ok: false; error: string } {
  const v = curp?.trim().toUpperCase() || null;
  if (!v) return { ok: true, curp: null };
  const r = validarCurp(v);
  if (!r.valida) return { ok: false, error: `CURP del médico inválida: ${r.motivo ?? "revísala"}` };
  return { ok: true, curp: r.curp };
}

/**
 * Nombre y apellidos resultantes: lo explícito del body manda; lo que falte
 * se toma de lo ya guardado y, si tampoco está, se parte de `nombre` (sólo
 * cuando NINGUNA parte existe: no se mezcla heurística con captura manual).
 */
export function partesNombreMedico(
  d: Pick<MedicoEntrada, "nombres" | "apellidoPaterno" | "apellidoMaterno"> & { nombre?: string | null },
  actual: { nombre: string; nombres: string | null; apellidoPaterno: string | null; apellidoMaterno: string | null } | null
): { nombres: string | null; apellidoPaterno: string | null; apellidoMaterno: string | null } {
  const explicito = {
    nombres: d.nombres !== undefined ? d.nombres || null : (actual?.nombres ?? null),
    apellidoPaterno: d.apellidoPaterno !== undefined ? d.apellidoPaterno || null : (actual?.apellidoPaterno ?? null),
    apellidoMaterno: d.apellidoMaterno !== undefined ? d.apellidoMaterno || null : (actual?.apellidoMaterno ?? null),
  };
  if (explicito.nombres || explicito.apellidoPaterno || explicito.apellidoMaterno) return explicito;
  const partes = dividirNombre(d.nombre ?? actual?.nombre);
  return partes ? { nombres: partes.nombres, apellidoPaterno: partes.apellidoPaterno, apellidoMaterno: partes.apellidoMaterno } : explicito;
}
