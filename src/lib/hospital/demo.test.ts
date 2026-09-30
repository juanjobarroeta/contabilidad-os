import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ doctor: vi.fn(), event: vi.fn(), patient: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { hospMedico: { findUnique: db.doctor }, hospControlEvento: { findFirst: db.event }, hospPaciente: { findFirst: db.patient } } }));
vi.mock('@/lib/authz', () => ({ AuthzError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { requirePractitioner } from './permisos';
import { DEMO_LEYENDA, demoText } from './demo';
import { crearNota, verificarHashNota } from './notas';
const demo = { id: 'doctor', activo: true, cedula: 'DEMO', credencialVerificadaAt: null, credencialEvidencia: null };
let enabled: boolean, patientEnabled: boolean;
beforeEach(() => {
  vi.clearAllMocks(); enabled = true; patientEnabled = true;
  db.doctor.mockResolvedValue(demo);
  db.patient.mockImplementation(async ({ where }) => where.companyId === 'company' && where.id === 'synthetic' ? { id: 'synthetic' } : null);
  db.event.mockImplementation(async ({ where }) => {
    if (where.companyId !== 'company') return null;
    if (where.tipo === 'DEMO_MEDICO_ACCESO' && where.referencia === 'user') return { datos: { habilitado: enabled, medicoId: 'doctor', pacienteIds: ['synthetic'] } };
    if (where.tipo === 'DEMO_PACIENTE' && where.referencia === 'synthetic') return { datos: { habilitado: patientEnabled } };
    return null;
  });
});
describe('bounded demo medical access', () => {
  it('allows the linked demo author only for an enrolled synthetic patient', async () => {
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).resolves.toMatchObject({ soloDemostracion: true, credencialVerificadaAt: null });
  });
  it.each([undefined, 'real-patient'])('rejects missing or real patient context: %s', async patientId => {
    await expect(requirePractitioner('company', 'user', 'doctor', patientId)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects other company, user, or requested author', async () => {
    for (const [company, user, doctor] of [['other', 'user', 'doctor'], ['company', 'other', 'doctor'], ['company', 'user', 'other']]) {
      await expect(requirePractitioner(company, user, doctor, 'synthetic')).rejects.toMatchObject({ status: 403 });
    }
  });
  it('requires a patient in the current company even if markers exist', async () => {
    db.patient.mockResolvedValue(null);
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
  });
  it('honors latest grant and patient-marker revocation', async () => {
    enabled = false;
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
    enabled = true; patientEnabled = false;
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
    expect(db.event).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  });
  it('rejects malformed grants, inactive doctors and non-demo unverified credentials', async () => {
    db.event.mockResolvedValue({ datos: { habilitado: true } });
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
    db.doctor.mockResolvedValue({ ...demo, activo: false });
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
    db.doctor.mockResolvedValue({ ...demo, cedula: '1234567' });
    await expect(requirePractitioner('company', 'user', 'doctor', 'synthetic')).rejects.toMatchObject({ status: 403 });
  });
  it('does not treat a demo sentinel with an accidental verification date as real authority', async () => {
    db.doctor.mockResolvedValue({ ...demo, credencialVerificadaAt: new Date(), credencialEvidencia: 'accidental' });
    await expect(requirePractitioner('company', 'user', 'doctor', 'real-patient')).rejects.toMatchObject({ status: 403 });
  });
  it('keeps the verified practitioner path unchanged', async () => {
    db.doctor.mockResolvedValue({ ...demo, cedula: '1234567', credencialVerificadaAt: new Date(), credencialEvidencia: 'verified' });
    await expect(requirePractitioner('company', 'user')).resolves.toMatchObject({ soloDemostracion: false });
    expect(db.event).not.toHaveBeenCalled();
  });
  it('persists the demo legend inside the signed content', async () => {
    const fakeDb = { hospMedico: { findUnique: async () => ({ ...demo, companyId: 'company' }) }, hospNota: { create: async ({ data }: any) => data } };
    const note = await crearNota(fakeDb as any, { companyId: 'company', episodioId: 'ep', tipo: 'PROCEDIMIENTO', medicoId: 'doctor', texto: demoText('Simulación de un procedimiento.', true), usuario: { id: 'user', nombre: 'Demo' } });
    expect(note.texto).toContain(DEMO_LEYENDA);
    expect(verificarHashNota(note)).toBe(true);
    expect(demoText('Clinical text', false)).toBe('Clinical text');
  });
});
