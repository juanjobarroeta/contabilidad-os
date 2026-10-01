import type { MesHistorial, ResumenHistorial } from "@/lib/onboarding/historial";

/** Respuesta de GET /api/onboarding/estado. */
export interface EstadoAlta {
  empresa: { rfc: string; razonSocial: string; anios: number; conFiel: boolean };
  meses: MesHistorial[];
  resumen: ResumenHistorial;
  conteos: { cfdis: number; clientes: number; proveedores: number };
  etapas: Array<{ clave: string; etiqueta: string; hechos: number; total: number; pct: number | null; completa: boolean }>;
  opinion: { resultado: string; fetchedAt: string } | null;
}

/** 0..1 del historial (meses cerrados descargados). */
export function avanceHistorial(e: EstadoAlta | null): number {
  if (!e || e.resumen.total === 0) return 0;
  return e.resumen.ok / e.resumen.total;
}
