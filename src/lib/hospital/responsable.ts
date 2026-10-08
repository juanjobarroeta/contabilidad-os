// ─────────────────────────────────────────────────────────────────────────────
// El adulto responsable del paciente.
//
// Quién responde por el paciente durante la atención y firma, como
// REPRESENTANTE, los consentimientos y documentos del paquete de admisión:
//   · TERCERO   — otra persona (familiar, tutor, representante legal), con los
//                 mismos datos de identificación que el paciente.
//   · PROPIO    — el propio paciente, mayor de edad.
//   · PENDIENTE — urgencia: se registra después; el panel lo avisa mientras
//                 el paciente tenga un episodio abierto.
// Un menor de edad no puede ser su propio responsable, y el responsable debe
// ser mayor de edad.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { HospResponsableModo } from "@prisma/client";
import { fechaSchema } from "./http";
import { validarCurp } from "./curp";
import { edad } from "./util";

export const RESPONSABLE_MODOS = ["TERCERO", "PROPIO", "PENDIENTE"] as const;
export const MAYORIA_DE_EDAD = 18;

export const responsableSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  apellidoPaterno: z.string().trim().min(1).max(120),
  apellidoMaterno: z.string().trim().max(120).nullable().optional(),
  parentesco: z.string().trim().min(1).max(60),
  fechaNacimiento: fechaSchema.nullable().optional(),
  sexo: z.enum(["FEMENINO", "MASCULINO", "OTRO"]).nullable().optional(),
  curp: z.string().trim().max(18).nullable().optional(),
  telefono: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(120).nullable().optional(),
  domicilio: z.string().trim().max(300).nullable().optional(),
  identificacionTipo: z.enum(["INE", "PASAPORTE", "LICENCIA", "CEDULA_PROFESIONAL", "CARTILLA", "CSF", "OTRO"]).nullable().optional(),
  identificacionNumero: z.string().trim().max(40).nullable().optional(),
});

export type ResponsableEntrada = z.infer<typeof responsableSchema>;

/** Lo que se guarda en HospResponsable (sin companyId/pacienteId). */
export interface ResponsableDatos {
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  parentesco: string;
  fechaNacimiento: Date | null;
  sexo: "FEMENINO" | "MASCULINO" | "OTRO" | null;
  curp: string | null;
  telefono: string;
  email: string | null;
  domicilio: string | null;
  identificacionTipo: ResponsableEntrada["identificacionTipo"] | null;
  identificacionNumero: string | null;
}

export type ResultadoResponsable =
  | { ok: true; modo: HospResponsableModo | null; responsable: ResponsableDatos | null }
  | { ok: false; status: number; error: string };

/**
 * Regla pura. `modo` undefined = la ficha no lo trae (clientes anteriores): no
 * se toca. Con TERCERO el responsable es obligatorio y mayor de edad; con
 * PROPIO o PENDIENTE no se guarda responsable.
 */
export function resolverResponsable(args: {
  modo: HospResponsableModo | null | undefined;
  responsable: ResponsableEntrada | null | undefined;
  fechaNacimientoPaciente: Date | null;
  fechaNacimientoResponsable?: Date | null;
  hoy?: Date;
}): ResultadoResponsable {
  const hoy = args.hoy ?? new Date();
  const modo = args.modo ?? null;
  const edadPaciente = edad(args.fechaNacimientoPaciente, hoy);
  if (modo === "PROPIO" && edadPaciente != null && edadPaciente < MAYORIA_DE_EDAD) {
    return { ok: false, status: 400, error: `El paciente tiene ${edadPaciente} años: un menor de edad necesita un adulto responsable` };
  }
  if (modo !== "TERCERO") return { ok: true, modo, responsable: null };

  const r = args.responsable;
  if (!r) return { ok: false, status: 400, error: "Captura los datos del adulto responsable (nombre, apellido, parentesco y teléfono)" };

  let curp: string | null = null;
  let sexo = r.sexo ?? null;
  let fechaNacimiento = args.fechaNacimientoResponsable ?? null;
  if (r.curp?.trim()) {
    const v = validarCurp(r.curp.trim().toUpperCase());
    if (!v.valida) return { ok: false, status: 400, error: `CURP del responsable: ${v.motivo ?? "inválida"}` };
    curp = v.curp;
    // La CURP dice sexo y nacimiento; si faltan, se toman de ella.
    if (!sexo && v.sexo) sexo = v.sexo;
    if (!fechaNacimiento && v.fechaNacimiento) fechaNacimiento = v.fechaNacimiento;
  }
  const edadResponsable = edad(fechaNacimiento, hoy);
  if (edadResponsable != null && edadResponsable < MAYORIA_DE_EDAD) {
    return { ok: false, status: 400, error: `El responsable tiene ${edadResponsable} años: debe ser mayor de edad` };
  }

  return {
    ok: true,
    modo,
    responsable: {
      nombre: r.nombre.trim(),
      apellidoPaterno: r.apellidoPaterno.trim(),
      apellidoMaterno: r.apellidoMaterno?.trim() || null,
      parentesco: r.parentesco.trim(),
      fechaNacimiento,
      sexo,
      curp,
      telefono: r.telefono.trim(),
      email: r.email?.trim() || null,
      domicilio: r.domicilio?.trim() || null,
      identificacionTipo: r.identificacionTipo ?? null,
      identificacionNumero: r.identificacionNumero?.trim() || null,
    },
  };
}

/** true si el paciente queda sin quien responda por él (panel: RESPONSABLE_PENDIENTE). */
export function responsablePendiente(p: { responsableModo: HospResponsableModo | null; fechaNacimiento: Date | null }, hoy: Date = new Date()): boolean {
  if (p.responsableModo === "PENDIENTE") return true;
  // Un menor sin responsable registrado (fichas anteriores) también cuenta.
  const e = edad(p.fechaNacimiento, hoy);
  return p.responsableModo !== "TERCERO" && e != null && e < MAYORIA_DE_EDAD;
}
