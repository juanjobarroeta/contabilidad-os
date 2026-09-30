import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consultarAlta, exigirAlta } from './alta-autorizacion';
import { hashNota } from './notas';
import { mensajeTransicion, TRANSICIONES } from './flujo';
const now = new Date('2026-09-30T12:00:00Z');
const ep = { id: 'ep', companyId: 'company', updatedAt: now, estado: 'HOSPITALIZADO' as const };
const note = { id: 'note', episodioId: 'ep', tipo: 'EGRESO' as const, fecha: now, texto: 'Autorización médica', secciones: {}, autorUserId: 'doctor-user', autorNombre: 'Doctor', autorCedula: '12345', medicoId: 'doctor', reemplazaId: null, reemplazadaPor: null };
const event = { id: 'approval', actorId: 'doctor-user', tipo: 'ALTA_AUTORIZACION', createdAt: now, datos: { episodioVersion: now.toISOString(), medicoId: 'doctor', medicoNombre: 'Doctor', notaId: 'note', venceAt: '2026-10-01T12:00:00Z', datos: { motivoEgreso: 'MEJORIA', diagnosticoEgresoCie10: 'J00', nota: 'Evolución favorable', instrucciones: 'Instrucciones firmadas' } } };
const find = vi.fn(), findNote = vi.fn();
const db = { hospControlEvento: { findFirst: find }, hospNota: { findUnique: findNote } } as any;
beforeEach(() => { vi.clearAllMocks(); find.mockResolvedValue(structuredClone(event)); findNote.mockResolvedValue({ ...note, hash: hashNota(note) }); });
describe('separate clinical approval and staff departure', () => {
  it('loads the current signed authorization and preserves its clinical author', async () => {
    await expect(exigirAlta(db, ep, 'approval', now)).resolves.toMatchObject({ vigente: true, medicoId: 'doctor', datos: event.datos.datos });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'company', referencia: 'ep' }) }));
  });
  it.each(['ALTA_REVOCACION', 'ALTA_EJECUTADA'])('latest %s blocks replay', async tipo => {
    find.mockResolvedValue({ ...event, tipo });
    await expect(exigirAlta(db, ep, 'approval', now)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects old approval ids, expiry, modified episode and closed episode', async () => {
    await expect(exigirAlta(db, ep, 'older', now)).rejects.toMatchObject({ status: 409 });
    await expect(exigirAlta(db, ep, 'approval', new Date('2026-10-01T12:00:00Z'))).rejects.toMatchObject({ status: 409 });
    await expect(exigirAlta(db, { ...ep, updatedAt: new Date(now.getTime() + 1) }, 'approval', now)).rejects.toMatchObject({ status: 409 });
    await expect(exigirAlta(db, { ...ep, estado: 'ALTA' }, 'approval', now)).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ reemplazadaPor: { id: 'correction' } }, { episodioId: 'other' }, { autorUserId: 'other' }, { medicoId: 'other' }, { texto: 'tampered' }])('rejects replaced, mismatched or tampered clinical notes: %j', async fields => {
    findNote.mockResolvedValue({ ...note, hash: hashNota(note), ...fields });
    await expect(exigirAlta(db, ep, 'approval', now)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects missing notes or malformed evidence', async () => {
    findNote.mockResolvedValue(null);
    await expect(exigirAlta(db, ep, 'approval', now)).rejects.toMatchObject({ status: 409 });
    find.mockResolvedValue({ ...event, datos: {} });
    await expect(exigirAlta(db, ep, 'approval', now)).rejects.toMatchObject({ status: 409 });
  });
});
describe('staff status choices', () => {
  it('allows deferring surgery without pretending the procedure occurred', () => {
    expect(TRANSICIONES.PREOPERATORIO).toContain('EN_VALORACION');
    expect(TRANSICIONES.PREOPERATORIO).toContain('HOSPITALIZADO');
    expect(TRANSICIONES.PREOPERATORIO).not.toContain('POSTOPERATORIO');
  });
  it('cannot bypass discharge authorization through a status update', () => {
    for (const states of Object.values(TRANSICIONES)) expect(states).not.toContain('ALTA');
    expect(TRANSICIONES.ALTA).toEqual([]);
    const error = mensajeTransicion('HOSPITALIZADO', 'EN_QUIROFANO');
    expect(error).toContain('preparación quirúrgica');
    expect(error).not.toContain('EN_QUIROFANO');
  });
});
