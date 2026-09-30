/** Explicit operator provisioning. Never marks a credential as verified or reuses a real patient.
 * DATABASE_URL=... npx tsx scripts/hospital-provision-medical-demo.ts RFC ADMIN_EMAIL REFERENCE
 * Re-run with the same reference to inspect the existing provision; it does not re-enable revoked access.
 */
import { PrismaClient } from '@prisma/client';
import { documentosRequeridos } from '../src/lib/hospital/episodio';
import { DEMO_CEDULA, DEMO_LEYENDA } from '../src/lib/hospital/demo';
const db = new PrismaClient();
async function main() {
  const [rfc, email, reference] = process.argv.slice(2);
  if (!rfc || !email || !reference || !/^[A-Z0-9-]{1,40}$/.test(reference)) throw Error('Supply company RFC, admin email and an uppercase reference (max 40 characters)');
  const company = await db.company.findUniqueOrThrow({ where: { rfc } });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const member = await db.companyMember.findUnique({ where: { userId_companyId: { userId: user.id, companyId: company.id } } });
  if (!member || !['ADMIN', 'OWNER'].includes(member.role) || !member.hospitalPermisos.includes('CLINICA_ESCRIBIR')) throw Error('An existing explicitly authorized hospital administrator is required');
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`demo-medical:${company.id}:${user.id}`}))`;
    const prior = await tx.hospControlEvento.findFirst({ where: { companyId: company.id, tipo: 'DEMO_PROVISION', referencia: reference } });
    if (prior) {
      if (prior.actorId !== user.id) throw Error('This reference belongs to a different administrator');
      return prior.datos;
    }
    const linked = await tx.hospMedico.findUnique({ where: { companyId_userId: { companyId: company.id, userId: user.id } } });
    if (linked) throw Error('An existing physician identity is linked; do not overwrite it');
    const doctor = await tx.hospMedico.create({ data: { companyId: company.id, userId: user.id, nombre: 'Médico DEMO — Administrador', especialidad: 'Demostración sin validez clínica', cedula: DEMO_CEDULA } });
    const patient = await tx.hospPaciente.create({ data: { companyId: company.id, nombre: 'PACIENTE DEMO', apellidoPaterno: 'DATOS FICTICIOS', expedienteNumero: `DEMO-${reference}`, fechaNacimiento: new Date('1990-01-01'), sexo: 'MASCULINO', sinCurp: true, sinCurpMotivo: DEMO_LEYENDA, antecedentes: DEMO_LEYENDA } });
    const episode = await tx.hospEpisodio.create({ data: { companyId: company.id, pacienteId: patient.id, medicoId: doctor.id, folio: `DEMO-${reference}`, tipo: 'HOSPITALIZACION', estado: 'HOSPITALIZADO', fechaIngreso: new Date(), diagnostico: 'Escenario ficticio para demostración', notasAdmin: DEMO_LEYENDA, creadoPorUserId: user.id } });
    await tx.hospDocumento.createMany({ data: documentosRequeridos({ tipo: episode.tipo, conCitaQuirofano: false }).map(d => ({ companyId: company.id, pacienteId: patient.id, episodioId: episode.id, ...d, requerido: true })) });
    await tx.hospControlEvento.create({ data: { companyId: company.id, tipo: 'DEMO_PACIENTE', referencia: patient.id, actorId: user.id, datos: { habilitado: true, leyenda: DEMO_LEYENDA, creadoParaDemostracion: true } } });
    await tx.hospControlEvento.create({ data: { companyId: company.id, tipo: 'DEMO_MEDICO_ACCESO', referencia: user.id, actorId: user.id, datos: { habilitado: true, medicoId: doctor.id, pacienteIds: [patient.id], motivo: 'Owner requested medical access for software demonstration', credencialVerificada: false } } });
    const provision = { companyId: company.id, userId: user.id, medicoId: doctor.id, pacienteId: patient.id, episodioId: episode.id, folio: episode.folio, credencialVerificada: false };
    await tx.hospControlEvento.create({ data: { companyId: company.id, tipo: 'DEMO_PROVISION', referencia: reference, actorId: user.id, datos: provision } });
    return provision;
  }, { timeout: 30000 });
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
