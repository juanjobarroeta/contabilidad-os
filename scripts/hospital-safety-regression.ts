/** Real HTTP + PostgreSQL regression. Synthetic records only; hard local guard. */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { crearEpisodio } from '../src/lib/hospital/episodio';
const url = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/hospitalos_audit_20260929') throw Error('Dedicated local synthetic database required');
const db = new PrismaClient();
const base = 'http://127.0.0.1:3017';
const run = randomUUID().slice(0, 8);
const results: unknown[] = [];
async function main() {
  const c = await db.company.findUniqueOrThrow({ where: { rfc: 'HHH190215K73' } });
  const password = randomUUID();
  async function actor(name: string, role: 'ACCOUNTANT' | 'OWNER', pages: string[], grants: string[], verified = false) {
    const user = await db.user.create({ data: { email: `${name}-${run}@hospitalos.test`, name: `SYNTHETIC ${name}`, password: await bcrypt.hash(password, 10) } });
    await db.companyMember.create({ data: { companyId: c.id, userId: user.id, role, hospitalPaginas: pages, hospitalPermisos: grants, allowedModules: ['HOSPITAL'] } });
    const medico = verified ? await db.hospMedico.create({ data: { companyId: c.id, nombre: user.name!, cedula: '12345678', userId: user.id, credencialVerificadaAt: new Date(), credencialVerificadaPor: 'synthetic-fixture', credencialEvidencia: 'Synthetic fixture only - not an actual practitioner' } }) : null;
    const login = await fetch(base + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password, cliente: 'hospital-safety-local' }) });
    const { token } = await login.json(); assert.ok(token, `login ${login.status}`);
    async function api(path: string, method = 'GET', body?: unknown) {
      const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await res.json(); return { status: res.status, data };
    }
    return { user, medico, api };
  }
  const maintenance = await actor('maintenance', 'ACCOUNTANT', ['mantenimiento'], []);
  const clinician = await actor('clinician', 'ACCOUNTANT', [], ['CLINICA_LEER', 'CLINICA_ESCRIBIR', 'ADMINISTRAR', 'ALTA', 'PRESCRIBIR'], true);
  const second = await actor('second', 'ACCOUNTANT', [], ['CLINICA_LEER', 'CLINICA_ESCRIBIR'], true);
  const unverified = await actor('unverified', 'ACCOUNTANT', [], ['CLINICA_LEER', 'CLINICA_ESCRIBIR', 'PRESCRIBIR']);
  const patient = await db.hospPaciente.create({ data: { companyId: c.id, nombre: 'SYNTHETIC', apellidoPaterno: `SAFETY ${run}`, sexo: 'MASCULINO', fechaNacimiento: new Date('1990-01-01'), sinCurp: true, sinCurpMotivo: 'Synthetic testing only' } });
  async function episode() { return crearEpisodio(db, { companyId: c.id, pacienteId: patient.id, medicoId: clinician.medico!.id, tipo: 'AMBULATORIO', procedimiento: 'Synthetic testing only', usuario: { id: clinician.user.id, nombre: clinician.user.name! } }); }
  const ep = await episode(), root = `/api/hospital/episodios/${ep.id}`;
  async function check(name: string, result: { status: number; data: any }, status: number) {
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result.data).slice(0, 600)}`);
    results.push({ case: name, status, passed: true }); return result.data;
  }
  await check('maintenance cannot read chart', await maintenance.api(root), 403);
  await check('maintenance cannot create note', await maintenance.api(root + '/notas', 'POST', { tipo: 'INDICACION', texto: 'SYNTHETIC', autorCedula: 'fake' }), 403);
  await check('unverified author rejected', await unverified.api(root + '/notas', 'POST', { tipo: 'INDICACION', texto: 'SYNTHETIC', autorCedula: '12345678' }), 403);
  await check('spoofed credential rejected', await clinician.api(root + '/notas', 'POST', { tipo: 'INDICACION', texto: 'SYNTHETIC', autorCedula: 'fake' }), 403);
  await check('verified doctor without prescribing grant rejected', await second.api(root + '/notas', 'POST', { tipo: 'INDICACION', texto: 'Synthetic scope test' }), 403);
  await check('verified author accepted', await clinician.api(root + '/notas', 'POST', { tipo: 'INDICACION', texto: 'SYNTHETIC: no real clinical instruction' }), 201);
  const insumo = await db.hospInsumo.create({ data: { companyId: c.id, clave: `SAFETY-${run}`, nombre: 'SYNTHETIC ITEM', categoria: 'MEDICAMENTO', precioVenta: 10 } });
  async function lot(label: string, expiry: Date | null, blocked = false) { return db.hospLote.create({ data: { companyId: c.id, insumoId: insumo.id, lote: label + run, caducidad: expiry, bloqueado: blocked, existencia: 10, costoUnitario: 5 } }); }
  const expired = await lot('expired', new Date('2020-01-01')), unknown = await lot('unknown', null), blocked = await lot('blocked', new Date('2035-01-01'), true);
  const body = { solicitudId: randomUUID(), insumoId: insumo.id, cantidad: 1 };
  for (const l of [expired, unknown, blocked]) await check('ineligible explicit lot rejected ' + l.lote, await clinician.api(root + '/aplicar-insumo', 'POST', { ...body, solicitudId: randomUUID(), loteId: l.id }), 409);
  await check('FEFO with only ineligible lots rejected', await clinician.api(root + '/aplicar-insumo', 'POST', body), 409);
  const valid = await lot('valid', new Date('2035-01-02'));
  const retries = await Promise.all(Array.from({ length: 4 }, () => clinician.api(root + '/aplicar-insumo', 'POST', body)));
  retries.forEach(r => assert.equal(r.status, 201, JSON.stringify(r.data)));
  assert.equal(new Set(retries.map(r => r.data.cargo.id)).size, 1);
  assert.equal(Number((await db.hospLote.findUniqueOrThrow({ where: { id: valid.id } })).existencia), 9);
  results.push({ case: 'four concurrent retries yield one charge/movement, stock 10 -> 9', passed: true });
  await check('reused key with different payload rejected', await clinician.api(root + '/aplicar-insumo', 'POST', { ...body, cantidad: 2 }), 409);
  await check('new event identity creates new application', await clinician.api(root + '/aplicar-insumo', 'POST', { ...body, solicitudId: randomUUID() }), 201);
  await check('preoperative transition', await clinician.api(root, 'PATCH', { action: 'estado', estado: 'PREOPERATORIO' }), 200);
  await check('ordinary surgery missing preparation rejected', await clinician.api(root, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 409);
  const emergency = { tipo: 'URGENCIA_QUIRURGICA', solicitudId: randomUUID(), pacienteNoPuedeConsentir: true, representanteNoDisponible: true, riesgoDemora: 'Synthetic scenario: delay creates an immediate documented risk.', seguimiento: 'Synthetic clinical lead to complete retrospective review.' };
  await check('first emergency attestation', await clinician.api(root + '/preparacion', 'POST', emergency), 201);
  await check('one physician cannot bypass', await clinician.api(root, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 409);
  await check('same physician cannot countersign', await clinician.api(root + '/preparacion', 'POST', emergency), 409);
  await check('independent physician attestation', await second.api(root + '/preparacion', 'POST', emergency), 201);
  await check('documented emergency transition', await clinician.api(root, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 200);
  const discharge = { action: 'alta', motivoEgreso: 'MEJORIA', diagnosticoEgresoCie10: 'J00', aldreteEgreso: 9 };
  await check('undocumented discharge rejected', await clinician.api(root, 'PATCH', discharge), 400);
  await check('complete discharge accepted', await clinician.api(root, 'PATCH', { ...discharge, nota: 'Synthetic recovery review; no actual patient.', instrucciones: 'Synthetic aftercare plan; no actual instruction.' }), 200);
  assert.equal(await db.hospNota.count({ where: { episodioId: ep.id, tipo: 'EGRESO' } }), 1);
  const room = await db.hospRecurso.create({ data: { companyId: c.id, tipo: 'QUIROFANO', area: 'QUIROFANO', nombre: `SYNTHETIC ${run}` } });
  const appointment = { companyId: c.id, recursoId: room.id, tipo: 'CIRUGIA', titulo: 'Synthetic booking', inicio: '2030-01-02T10:00:00Z', fin: '2030-01-02T11:00:00Z' };
  const bookings = await Promise.all(Array.from({ length: 4 }, () => clinician.api('/api/hospital/citas', 'POST', appointment)));
  assert.deepEqual(bookings.map(r => r.status).sort(), [201, 409, 409, 409], JSON.stringify(bookings));
  results.push({ case: 'four concurrent room bookings yield one reservation', passed: true });

  const elective = await episode(), electiveRoot = `/api/hospital/episodios/${elective.id}`;
  await clinician.api(electiveRoot, 'PATCH', { action: 'estado', estado: 'PREOPERATORIO' });
  await check('checklist saved by verified practitioner', await clinician.api(electiveRoot + '/preparacion', 'POST', { tipo: 'PREPARACION', identidad: true, procedimiento: true, alergias: true, nota: 'Synthetic team preparation completed.' }), 201);
  await check('checklist alone cannot replace consents', await clinician.api(electiveRoot, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 409);
  await db.hospDocumento.updateMany({ where: { episodioId: elective.id, tipo: { in: ['CONSENTIMIENTO_CIRUGIA', 'CONSENTIMIENTO_ANESTESIA'] } }, data: { estado: 'FIRMADO', firmadoAt: new Date() } });
  await check('complete elective preparation succeeds', await clinician.api(electiveRoot, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 200);
  const patientRoot = `/api/hospital/pacientes/${patient.id}/gestiones`;
  await check('retention metadata readable by clinician', await clinician.api(patientRoot), 200);
  await check('incomplete privacy record rejected', await clinician.api(patientRoot, 'POST', { tipo: 'PRIVACIDAD_CONSENTIMIENTO' }), 400);
  const request = await check('summary request records representation', await clinician.api(patientRoot, 'POST', { tipo: 'RESUMEN_SOLICITUD', solicitante: 'Synthetic patient', representacion: 'Synthetic verified identity reference', finalidad: 'Synthetic continuity request', evidencia: 'Synthetic request document reference' }), 201);
  const delivery = { tipo: 'RESUMEN_ENTREGA', solicitudId: request.id, diagnostico: 'Synthetic diagnosis', evolucion: 'Synthetic evolution', tratamiento: 'Synthetic treatment', pronostico: 'Synthetic prognosis', receptor: 'Synthetic recipient', acuse: 'Synthetic acknowledgement', evidencia: 'Synthetic delivery evidence' };
  await check('unverified summary delivery rejected', await unverified.api(patientRoot, 'POST', delivery), 403);
  await check('verified summary delivery recorded', await clinician.api(patientRoot, 'POST', delivery), 201);
  await check('unlinked summary delivery rejected', await clinician.api(patientRoot, 'POST', { ...delivery, solicitudId: 'missing' }), 400);
  const owner = await actor('owner', 'OWNER', [], ['CLINICA_LEER', 'CLINICA_ESCRIBIR']);
  const reviewer = await actor('reviewer', 'OWNER', [], ['CLINICA_LEER']);
  const existing = await owner.api(`/api/hospital/cumplimiento?companyId=${c.id}`);
  const prior = existing.data.obligaciones.find((o: any) => o.clave === 'LICENCIA').ultimo;
  const evidence = { companyId: c.id, clave: 'LICENCIA', version: prior?.id ?? null, estado: 'EN_REVISION', responsable: 'Synthetic facility reviewer', evidencia: `Synthetic evidence ${run}; not a real licence`, vence: '2020-01-01', siguienteRevision: '2030-01-01' };
  const proposed = await check('compliance evidence submitted', await owner.api('/api/hospital/cumplimiento', 'POST', evidence), 201);
  const approval = { ...evidence, version: proposed.id, estado: 'VERIFICADO' };
  await check('self verification blocked', await owner.api('/api/hospital/cumplimiento', 'POST', approval), 409);
  await check('independent review recorded', await reviewer.api('/api/hospital/cumplimiento', 'POST', approval), 201);
  await check('stale evidence edit rejected', await owner.api('/api/hospital/cumplimiento', 'POST', evidence), 409);
  const reviewed = await owner.api(`/api/hospital/cumplimiento?companyId=${c.id}`);
  assert.equal(reviewed.data.obligaciones.find((o: any) => o.clave === 'LICENCIA').estado, 'VENCIDO');
  results.push({ case: 'expired evidence cannot display current verified state', passed: true });
  const waste = await check('RPBI generation recorded', await owner.api('/api/hospital/cumplimiento/operacion', 'POST', { companyId: c.id, tipo: 'RPBI_GENERACION', fecha: '2026-09-29', area: 'Synthetic room', clasificacion: 'Synthetic category', envasado: 'Synthetic container', almacenamiento: 'Synthetic storage', kilogramos: 1.25, responsable: 'Synthetic operator' }), 201);
  const disposal = { companyId: c.id, tipo: 'RPBI_DISPOSICION', registroId: waste.id, fecha: '2026-09-29', tratamiento: 'Synthetic treatment', disposicion: 'Synthetic final disposal', evidencia: 'Synthetic final receipt' };
  await check('RPBI cannot skip pickup evidence', await owner.api('/api/hospital/cumplimiento/operacion', 'POST', disposal), 409);
  await check('RPBI pickup recorded', await owner.api('/api/hospital/cumplimiento/operacion', 'POST', { companyId: c.id, tipo: 'RPBI_RECOLECCION', registroId: waste.id, fecha: '2026-09-29', transportista: 'Synthetic transporter', autorizacion: 'Synthetic permit', manifiesto: 'Synthetic manifest', receptor: 'Synthetic receiver' }), 201);
  await check('RPBI chain completed', await owner.api('/api/hospital/cumplimiento/operacion', 'POST', disposal), 201);
  const change = await check('responsible officer departure recorded', await owner.api('/api/hospital/cumplimiento/operacion', 'POST', { companyId: c.id, tipo: 'RESPONSABLE_BAJA', fecha: '2026-09-29', nombre: 'Synthetic officer', cedula: '12345678', evidencia: 'Synthetic departure evidence' }), 201);
  assert.equal(change.datos.avisoLimite, '2026-10-14'); assert.equal(change.datos.sustitucionLimite, '2026-10-29');
  await check('daily register restricted', await maintenance.api(`/api/hospital/registros?companyId=${c.id}&fecha=2026-09-29`), 403);
  await check('daily register available to clinical role', await clinician.api(`/api/hospital/registros?companyId=${c.id}&fecha=2026-09-29`), 200);
  await db.hospPaciente.createMany({ data: Array.from({ length: 60 }, (_, n) => ({ companyId: c.id, nombre: `PAGE${run}`, apellidoPaterno: `SYNTHETIC ${n}`, sexo: 'MASCULINO' as const, fechaNacimiento: new Date('1990-01-01'), sinCurp: true, sinCurpMotivo: 'Synthetic pagination fixture' })) });
  const page1 = await clinician.api(`/api/hospital/pacientes?companyId=${c.id}&q=PAGE${run}&page=1`);
  const page2 = await clinician.api(`/api/hospital/pacientes?companyId=${c.id}&q=PAGE${run}&page=2`);
  assert.equal(page1.data.total, 60); assert.equal(page1.data.pacientes.length, 50); assert.equal(page2.data.pacientes.length, 10);
  assert.equal(new Set([...page1.data.pacientes, ...page2.data.pacientes].map((p: any) => p.id)).size, 60);
  results.push({ case: 'pagination returns total and distinct complete pages', passed: true });
  await assert.rejects(db.hospControlEvento.update({ where: { id: proposed.id }, data: { tipo: 'TAMPERED' } }));
  results.push({ case: 'database rejects mutation of control history', passed: true });
  writeFileSync('/tmp/hospital-safety-regression.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => db.$disconnect());
