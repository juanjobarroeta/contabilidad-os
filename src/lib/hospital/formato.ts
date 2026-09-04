// Helpers de presentación compartidos por las rutas fiscales del módulo
// HOSPITAL (panel, buscar, perfil, kardex). Sin base de datos.

import type { HospArea } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** «María F. Ortega Ruiz» a partir de las tres columnas del paciente. */
export function nombrePaciente(p: {
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno?: string | null;
}): string {
  return [p.nombre, p.apellidoPaterno, p.apellidoMaterno].filter(Boolean).join(" ").trim();
}

export const AREA_LABEL: Record<HospArea, string> = {
  HOSPITALIZACION: "Hospitalización",
  URGENCIAS: "Urgencias",
  RECUPERACION: "Recuperación",
  TERAPIA: "Terapia",
  QUIROFANO: "Quirófano",
  CONSULTA_EXTERNA: "Consulta externa",
  ENDOSCOPIA: "Endoscopía",
  IMAGEN: "Imagen",
  LABORATORIO: "Laboratorio",
  OTRA: "Otra",
};

/** Total con IVA de un cargo: importe × (1 + tasa); null = exento. */
export function totalCargo(c: { importe: unknown; ivaTasa: unknown }): number {
  const importe = Number(c.importe ?? 0);
  const tasa = c.ivaTasa == null ? 0 : Number(c.ivaTasa);
  return r2(importe * (1 + tasa));
}

/** Estados de episodio que ocupan el hospital hoy (ni programado ni cerrado). */
export const ESTADOS_EPISODIO_ACTIVO = [
  "EN_VALORACION",
  "PREOPERATORIO",
  "EN_QUIROFANO",
  "POSTOPERATORIO",
  "HOSPITALIZADO",
] as const;

/** Fecha local yyyy-mm-dd (la del servidor, igual que el resto del hub). */
export function fechaIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
