import { describe, expect, it } from 'vitest';
import { conservarHasta, gestionSchema } from './gestiones';
describe('patient rights evidence', () => {
  it('computes five calendar years from the last act including leap day', () => {
    expect(conservarHasta(new Date('2024-02-29T18:00:00Z')).toISOString()).toBe('2029-02-28T18:00:00.000Z');
    expect(conservarHasta(new Date('2026-09-29T18:00:00Z')).toISOString()).toBe('2031-09-29T18:00:00.000Z');
  });
  it('requires representation and written evidence for a summary request', () => {
    expect(gestionSchema.safeParse({ tipo: 'RESUMEN_SOLICITUD', solicitante: 'Synthetic' }).success).toBe(false);
    expect(gestionSchema.safeParse({ tipo: 'RESUMEN_SOLICITUD', solicitante: 'Synthetic', representacion: 'Documented identity', finalidad: 'Continuity', evidencia: 'Signed request reference' }).success).toBe(true);
  });
  it('requires both a legal basis and scoped necessity for a privacy exception', () => {
    expect(gestionSchema.safeParse({ tipo: 'PRIVACIDAD_EXCEPCION', evidencia: 'Hospital note reference' }).success).toBe(false);
  });
});
