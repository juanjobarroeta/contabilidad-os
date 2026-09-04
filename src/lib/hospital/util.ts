// Utilería compartida del módulo HOSPITAL: redondeo de dinero, nombres y edad.
// Sin Prisma: lo que necesita base vive en cada archivo de regla de negocio.

import type { HospCargoCategoria, HospEpisodioEstado } from "@prisma/client";
import { diasEntre, partesLocales } from "./tz";

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Estados en los que el episodio sigue abierto (ocupa cama, acumula cuenta). */
export const ESTADOS_ACTIVOS: HospEpisodioEstado[] = [
  "PROGRAMADO",
  "EN_VALORACION",
  "PREOPERATORIO",
  "EN_QUIROFANO",
  "POSTOPERATORIO",
  "HOSPITALIZADO",
];

export function esActivo(estado: HospEpisodioEstado): boolean {
  return estado !== "ALTA" && estado !== "CANCELADO";
}

export function nombreCompleto(p: {
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno?: string | null;
}): string {
  return [p.nombre, p.apellidoPaterno, p.apellidoMaterno].filter(Boolean).join(" ").trim();
}

/** Edad en años cumplidos al día local de `hoy`; null sin fecha de nacimiento. */
export function edad(fechaNacimiento: Date | null | undefined, hoy: Date = new Date()): number | null {
  if (!fechaNacimiento) return null;
  const n = partesLocales(fechaNacimiento);
  const h = partesLocales(hoy);
  let anios = h.y - n.y;
  if (h.m < n.m || (h.m === n.m && h.d < n.d)) anios--;
  return Math.max(0, anios);
}

/** Cómo firma el usuario en notas, signos y traslados: nombre o, si no, correo. */
export function nombreUsuario(user: { name?: string | null; email?: string | null } | null | undefined): string {
  return user?.name?.trim() || user?.email || "Sistema";
}

/**
 * IVA default por categoría cuando el servicio/cargo no trae tasa:
 * honorarios exentos (Art. 15-XIV LIVA), farmacia a tasa 0 (Art. 2-A,
 * medicinas de patente), lo demás con la tasa de la empresa (0.16).
 */
export function ivaDefault(categoria: HospCargoCategoria, ivaServicios: number | null | undefined): number | null {
  if (categoria === "HONORARIO") return null;
  if (categoria === "FARMACIA") return 0;
  return ivaServicios ?? 0.16;
}

/** Día de estancia: el día del ingreso es el 1. Nunca menor que 1. */
export function diaDeEstanciaSimple(fechaIngreso: Date, hoy: Date): number {
  return Math.max(1, diasEntre(fechaIngreso, hoy) + 1);
}
