import type { HospEpisodioEstado } from '@prisma/client';
export const ESTADO_TEXTO: Record<HospEpisodioEstado, string> = {
  PROGRAMADO: 'programado', EN_VALORACION: 'en valoración', PREOPERATORIO: 'en preparación quirúrgica',
  EN_QUIROFANO: 'en quirófano', POSTOPERATORIO: 'en recuperación', HOSPITALIZADO: 'hospitalizado', ALTA: 'dado de alta', CANCELADO: 'cancelado',
};
export const TRANSICIONES: Record<HospEpisodioEstado, HospEpisodioEstado[]> = {
  PROGRAMADO: ['EN_VALORACION', 'PREOPERATORIO', 'HOSPITALIZADO'],
  EN_VALORACION: ['PREOPERATORIO', 'HOSPITALIZADO'],
  // A deferred procedure can return to observation without pretending surgery occurred.
  PREOPERATORIO: ['EN_QUIROFANO', 'EN_VALORACION', 'HOSPITALIZADO'],
  EN_QUIROFANO: ['POSTOPERATORIO'], POSTOPERATORIO: ['HOSPITALIZADO'],
  HOSPITALIZADO: ['PREOPERATORIO'], ALTA: [], CANCELADO: [],
};
export function mensajeTransicion(de: HospEpisodioEstado, a: HospEpisodioEstado) {
  const siguientes = TRANSICIONES[de].map(e => ESTADO_TEXTO[e]).join(', ');
  return `El paciente está ${ESTADO_TEXTO[de]} y no puede pasar directamente a ${ESTADO_TEXTO[a]}.${siguientes ? ` Elige uno de estos pasos: ${siguientes}.` : ' Este episodio ya está cerrado.'}`;
}
