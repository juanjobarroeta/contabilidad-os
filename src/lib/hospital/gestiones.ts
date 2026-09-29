import { z } from 'zod';
const texto = z.string().trim().min(1).max(4000);
const nombre = z.string().trim().min(1).max(200);
const base = { evidencia: texto };
export const gestionSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('RESUMEN_SOLICITUD'), ...base, solicitante: nombre, representacion: texto, finalidad: texto }),
  z.object({ tipo: z.literal('RESUMEN_ENTREGA'), ...base, solicitudId: z.string().min(1), diagnostico: texto, evolucion: texto, tratamiento: texto, pronostico: texto, receptor: nombre, acuse: texto }),
  z.object({ tipo: z.literal('REPRESENTACION'), ...base, representante: nombre, relacion: nombre, capacidad: z.enum(['MENOR', 'INCAPACIDAD_DOCUMENTADA', 'REPRESENTACION_VOLUNTARIA']), fundamento: texto, vigenteHasta: z.string().date().nullable() }),
  z.object({ tipo: z.literal('PRIVACIDAD_CONSENTIMIENTO'), ...base, avisoVersion: nombre, finalidades: texto, mecanismoAutenticacion: texto, otorgante: nombre }),
  z.object({ tipo: z.literal('PRIVACIDAD_EXCEPCION'), ...base, baseJuridica: texto, necesidad: texto, alcance: texto }),
  z.object({ tipo: z.literal('PRIVACIDAD_REVOCACION'), ...base, consentimientoId: z.string().min(1), alcance: texto, seguimiento: texto }),
  z.object({ tipo: z.literal('ARCO_SOLICITUD'), ...base, derecho: z.enum(['ACCESO', 'RECTIFICACION', 'CANCELACION', 'OPOSICION']), solicitante: nombre, representacion: texto, alcance: texto, fechaLimiteRevision: z.string().date() }),
  z.object({ tipo: z.literal('ARCO_RESOLUCION'), ...base, solicitudId: z.string().min(1), decision: texto, acuse: texto }),
  z.object({ tipo: z.literal('VOLUNTAD_ANTICIPADA'), ...base, otorgante: nombre, capacidadYRepresentacion: texto, instrucciones: texto, planPaliativo: texto, revisionClinica: texto }),
  z.object({ tipo: z.literal('RETENCION'), ...base, estado: z.enum(['ACTIVA', 'LIBERADA']), motivo: texto }),
]);
export function conservarHasta(ultimoActo: Date) {
  const fecha = new Date(ultimoActo);
  const month = fecha.getUTCMonth();
  fecha.setUTCFullYear(fecha.getUTCFullYear() + 5);
  // Feb 29 -> last day of Feb, not March 1.
  if (fecha.getUTCMonth() !== month) fecha.setUTCDate(0);
  return fecha;
}
