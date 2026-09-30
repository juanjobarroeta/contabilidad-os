/** Synthetic-only real HTTP/PostgreSQL regression for the clinical/staff handoff. */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const url = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/hospitalos_audit_20260929') throw Error('Dedicated local synthetic database required');
const db = new PrismaClient();
const base = process.env.WORKFLOW_TEST_URL || 'http://127.0.0.1:3018';
if (!base.startsWith('http://127.0.0.1:')) throw Error('Local HTTP server required');
const run = randomUUID().slice(0, 8), password = randomUUID();
const results: string[] = [];
async function main() {
  const company = await db.company.findUniqueOrThrow({ where: { rfc: 'HHH190215K73' }, select: { id: true } });
  const companyId = company.id;
  async function actor(label: string, role: 'ACCOUNTANT' | 'VIEWER', grants: string[], verified = false) {
    const user = await db.user.create({ data: { email: `workflow-${label}-${run}@hospitalos.test`, name: `SYNTHETIC ${label}`, password: await bcrypt.hash(password, 10) } });
    await db.companyMember.create({ data: { companyId, userId: user.id, role, allowedModules: ['HOSPITAL'], hospitalPermisos: grants } });
    const medico = verified ? await db.hospMedico.create({ data: { companyId, userId: user.id, nombre: 'SYNTHETIC physician', cedula: '1234567', credencialVerificadaAt: new Date(), credencialVerificadaPor: 'synthetic-fixture', credencialEvidencia: 'LOCAL SYNTHETIC TEST ONLY' } }) : null;
    const login = await fetch(base + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
    const { token } = await login.json(); assert.ok(token, `login ${login.status}`);
    async function api(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    }
    return { user, medico, api };
  }
  const grants = ['CLINICA_LEER', 'CLINICA_ESCRIBIR', 'ALTA'];
  const physician = await actor('physician', 'ACCOUNTANT', grants, true);
  const staff = await actor('staff', 'ACCOUNTANT', grants);
  const reader = await actor('reader', 'VIEWER', grants);
  const noDischarge = await actor('admissions', 'ACCOUNTANT', grants.filter(g => g !== 'ALTA'));
  const patient = await db.hospPaciente.create({ data: { companyId, nombre: 'SYNTHETIC WORKFLOW', apellidoPaterno: run, sinCurp: true, sinCurpMotivo: 'Local synthetic test' } });
  async function episode() { return db.hospEpisodio.create({ data: { companyId, pacienteId: patient.id, folio: `WORKFLOW-${randomUUID()}`, tipo: 'HOSPITALIZACION', estado: 'HOSPITALIZADO', fechaIngreso: new Date(Date.now() - 3600000), medicoId: physician.medico!.id } }); }
  async function check(name: string, response: { status: number; data: any }, status: number) { assert.equal(response.status, status, `${name}: ${JSON.stringify(response.data)}`); results.push(name); return response.data; }
  const ep = await episode(), root = `/api/hospital/episodios/${ep.id}`;
  const preparation = { tipo: 'PREPARACION', identidad: true, procedimiento: true, alergias: true, nota: 'SYNTHETIC team verification' };
  await check('staff can record ordinary preparation', await staff.api(root + '/preparacion', 'POST', preparation), 201);
  await check('viewer cannot record preparation', await reader.api(root + '/preparacion', 'POST', preparation), 403);
  await check('staff cannot attest a medical emergency', await staff.api(root + '/preparacion', 'POST', { tipo: 'URGENCIA_QUIRURGICA', solicitudId: randomUUID(), pacienteNoPuedeConsentir: true, representanteNoDisponible: true, riesgoDemora: 'Synthetic emergency explanation for local test', seguimiento: 'Synthetic follow-up only' }), 403);
  await check('staff moves patient to preparation', await staff.api(root, 'PATCH', { action: 'estado', estado: 'PREOPERATORIO' }), 200);
  const missing = await check('surgery consent checks remain enforced', await staff.api(root, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 409);
  assert.ok(missing.error.includes('consentimiento de cirugía firmado')); assert.ok(!missing.error.includes('CONSENTIMIENTO_'));
  await db.hospDocumento.createMany({ data: (['CONSENTIMIENTO_CIRUGIA', 'CONSENTIMIENTO_ANESTESIA'] as const).map(tipo => ({ companyId, pacienteId: patient.id, episodioId: ep.id, tipo, nombre: 'SYNTHETIC consent', estado: 'FIRMADO' as const, firmadoAt: new Date() })) });
  await check('staff records OR entry without a physician identity', await staff.api(root, 'PATCH', { action: 'estado', estado: 'EN_QUIROFANO' }), 200);
  await check('staff records recovery', await staff.api(root, 'PATCH', { action: 'estado', estado: 'POSTOPERATORIO' }), 200);
  await check('staff records return to ward', await staff.api(root, 'PATCH', { action: 'estado', estado: 'HOSPITALIZADO' }), 200);
  const clinical = { motivoEgreso: 'MEJORIA', diagnosticoEgresoCie10: 'J00', nota: 'SYNTHETIC clinical recovery summary', instrucciones: 'SYNTHETIC aftercare instructions, no actual treatment' };
  await check('staff cannot authorize a clinical discharge', await staff.api(root, 'PATCH', { action: 'autorizar_alta', ...clinical }), 403);
  await check('physician authorizes without recording departure', await physician.api(root, 'PATCH', { action: 'autorizar_alta', ...clinical }), 200);
  assert.equal((await db.hospEpisodio.findUniqueOrThrow({ where: { id: ep.id } })).estado, 'HOSPITALIZADO');
  let chart = await check('staff sees a pending signed discharge', await staff.api(root), 200);
  assert.equal(chart.acciones.puedeAutorizarAlta, false); assert.equal(chart.acciones.puedeRegistrarSalida, true);
  assert.deepEqual(chart.estadosPermitidos, ['PREOPERATORIO']);
  const departure = { action: 'registrar_salida', autorizacionId: chart.altaAutorizada.id };
  await check('staff cannot replace signed clinical instructions', await staff.api(root, 'PATCH', { ...departure, instrucciones: 'tampered' }), 400);
  await check('viewer cannot record departure', await reader.api(root, 'PATCH', departure), 403);
  await check('staff needs an explicit discharge permission', await noDischarge.api(root, 'PATCH', departure), 403);
  const other = await episode();
  await check('authorization cannot be reused for another episode', await staff.api(`/api/hospital/episodios/${other.id}`, 'PATCH', departure), 409);
  const concurrent = await Promise.all([staff.api(root, 'PATCH', departure), staff.api(root, 'PATCH', departure)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]); results.push('concurrent departures complete exactly once');
  const notes = await db.hospNota.findMany({ where: { episodioId: ep.id, tipo: 'EGRESO' } });
  assert.equal(notes.length, 1); assert.equal(notes[0].autorUserId, physician.user.id); assert.equal(notes[0].medicoId, physician.medico!.id);
  const movements = await db.hospTraslado.findMany({ where: { episodioId: ep.id, tipo: 'ALTA' } });
  assert.equal(movements.length, 1); assert.equal(movements[0].usuarioId, staff.user.id); results.push('clinical signature and staff departure recorder remain distinct');
  const secondRoot = `/api/hospital/episodios/${other.id}`;
  await physician.api(secondRoot, 'PATCH', { action: 'autorizar_alta', ...clinical });
  chart = await check('second approval available', await staff.api(secondRoot), 200);
  await check('staff can suspend a pending discharge', await staff.api(secondRoot, 'PATCH', { action: 'revocar_alta', motivo: 'Synthetic change in clinical condition' }), 200);
  await check('revoked authorization cannot be used', await staff.api(secondRoot, 'PATCH', { action: 'registrar_salida', autorizacionId: chart.altaAutorizada.id }), 409);
  await physician.api(secondRoot, 'PATCH', { action: 'autorizar_alta', ...clinical });
  chart = (await staff.api(secondRoot)).data;
  await staff.api(secondRoot, 'PATCH', { action: 'estado', estado: 'PREOPERATORIO' });
  await check('changed episode requires fresh clinical approval', await staff.api(secondRoot, 'PATCH', { action: 'registrar_salida', autorizacionId: chart.altaAutorizada.id }), 409);
  await check('deferred surgery can return to the ward', await staff.api(secondRoot, 'PATCH', { action: 'estado', estado: 'HOSPITALIZADO' }), 200);
  const direct = await episode();
  await check('physician can still authorize and discharge together', await physician.api(`/api/hospital/episodios/${direct.id}`, 'PATCH', { action: 'alta', ...clinical }), 200);
  await physician.api(secondRoot, 'PATCH', { action: 'autorizar_alta', ...clinical });
  writeFileSync('/tmp/hospital-workflow-ui.json', JSON.stringify({ staffEmail: staff.user.email, physicianEmail: physician.user.email, password, episodeId: other.id, companyId }), { mode: 0o600 });
  writeFileSync('/tmp/hospital-workflow-http-results.json', JSON.stringify({ passed: results.length, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
