import { describe, it, expect, vi } from 'vitest';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { hospAcceso: { create } } }));
vi.mock('@/lib/authz', () => ({ AuthzError: class extends Error { constructor(public status: number, message: string) { super(message) } } }));
vi.mock('@/lib/audit', () => ({ ipDeRequest: () => null }));
import { registrarAcceso } from './accesos';
describe('durable clinical access', () => {
  it('waits for the database before completing access', async () => {
    let finish!: (value: unknown) => void;
    create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }));
    let delivered = false;
    const access = registrarAcceso({ companyId: 'synthetic', accion: 'LECTURA_EXPEDIENTE' }).then(() => { delivered = true });
    await Promise.resolve(); expect(delivered).toBe(false);
    finish({ id: 'audit' }); await access; expect(delivered).toBe(true);
  });
  it('fails closed when audit storage fails', async () => {
    create.mockRejectedValueOnce(new Error('database offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(registrarAcceso({ companyId: 'synthetic', accion: 'EXPORTACION' })).rejects.toMatchObject({ status: 503 });
    spy.mockRestore();
  });
});
