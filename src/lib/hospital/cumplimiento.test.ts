import { it, expect } from 'vitest';
import { estadoObligacion } from './cumplimiento';
it('unknown is not verified and expiry invalidates the reviewed state', () => {
  expect(estadoObligacion(undefined)).toBe('SIN_EVIDENCIA');
  expect(estadoObligacion({ estado: 'VERIFICADO', vence: '2026-09-29' }, new Date('2026-09-30T05:59:59Z'))).toBe('VERIFICADO');
  expect(estadoObligacion({ estado: 'VERIFICADO', vence: '2026-09-29' }, new Date('2026-09-30T06:00:00Z'))).toBe('VENCIDO');
});
