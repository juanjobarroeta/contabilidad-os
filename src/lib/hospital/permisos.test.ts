import { beforeEach, describe, expect, it, vi } from 'vitest';
const { member, find, membership } = vi.hoisted(() => ({ member: { role: 'ACCOUNTANT', hospitalPaginas: [] as string[], hospitalPermisos: [] as string[] }, find: vi.fn(), membership: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { companyMember: { findUnique: find } } }));
vi.mock('@/lib/authz', () => ({ requireMembership: membership, AuthzError: class extends Error { constructor(public status: number, message: string) { super(message) } } }));
import { combinarPermisos, enforceHospitalAccess, PERMISOS_CLINICOS, permisosDelGrupo } from './permisos';
beforeEach(() => { member.role = 'ACCOUNTANT'; member.hospitalPaginas = []; member.hospitalPermisos = []; find.mockResolvedValue(member); membership.mockResolvedValue({ membership: member }); });
const request = (path: string, method = 'GET') => new Request(`https://local.test/api/hospital/${path}`, { method });
describe('hospital server permission matrix', () => {
  it('enforces page scope even if the user has a clinical grant', async () => {
    member.hospitalPaginas = ['mantenimiento']; member.hospitalPermisos = ['CLINICA_LEER'];
    await expect(enforceHospitalAccess('company', 'user', request('episodios/one'))).rejects.toMatchObject({ status: 403 });
  });
  it.each(['farmacia/kardex', 'farmacia/libro-control', 'censo', 'panel', 'registros'])('protects patient-bearing report %s', async path => {
    await expect(enforceHospitalAccess('company', 'user', request(path))).rejects.toMatchObject({ status: 403 });
    member.hospitalPermisos = ['CLINICA_LEER'];
    await expect(enforceHospitalAccess('company', 'user', request(path))).resolves.toBeUndefined();
  });
  it('separates clinical administration from financial writes', async () => {
    member.hospitalPermisos = ['CLINICA_ESCRIBIR', 'ADMINISTRAR'];
    await expect(enforceHospitalAccess('company', 'user', request('episodios/one/cargos', 'POST'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPermisos.push('FINANZAS_ESCRIBIR');
    await expect(enforceHospitalAccess('company', 'user', request('episodios/one/cargos', 'POST'))).resolves.toBeUndefined();
  });
  it('terminal settlements belong to Caja/Bancos, not Médicos', async () => {
    member.hospitalPaginas = ['medicos'];
    await expect(enforceHospitalAccess('company', 'user', request('liquidaciones'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPaginas = ['bancos'];
    await expect(enforceHospitalAccess('company', 'user', request('liquidaciones'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('afiliaciones'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('liquidaciones', 'POST'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPermisos = ['FINANZAS_ESCRIBIR'];
    await expect(enforceHospitalAccess('company', 'user', request('liquidaciones', 'POST'))).resolves.toBeUndefined();
  });
  it('viewer cannot gain write access through a stale grant', async () => {
    member.role = 'VIEWER'; member.hospitalPermisos = ['CLINICA_ESCRIBIR'];
    await expect(enforceHospitalAccess('company', 'user', request('episodios/one/notas', 'POST'))).rejects.toMatchObject({ status: 403 });
  });
  it('quotation conversion requires clinical authority', async () => {
    member.hospitalPaginas = ['cotizaciones']; member.hospitalPermisos = ['FINANZAS_ESCRIBIR'];
    await expect(enforceHospitalAccess('company', 'user', request('cotizaciones/one/convertir', 'POST'))).rejects.toMatchObject({ status: 403 });
  });
  it('invoicing is reachable from caja and needs FINANZAS_ESCRIBIR to write', async () => {
    member.hospitalPaginas = ['caja'];
    await expect(enforceHospitalAccess('company', 'user', request('facturacion/prefacturas'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('facturacion/prefacturas/one', 'POST'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPermisos = ['FINANZAS_ESCRIBIR'];
    await expect(enforceHospitalAccess('company', 'user', request('facturacion/prefacturas/one', 'POST'))).resolves.toBeUndefined();
    member.hospitalPaginas = ['farmacia'];
    await expect(enforceHospitalAccess('company', 'user', request('facturacion/prefacturas'))).rejects.toMatchObject({ status: 403 });
  });
  it('payroll writes need the nomina page and FINANZAS_ESCRIBIR', async () => {
    member.hospitalPaginas = ['nomina'];
    await expect(enforceHospitalAccess('company', 'user', request('nomina/aguinaldo'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('nomina/empleados', 'POST'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPermisos = ['FINANZAS_ESCRIBIR'];
    await expect(enforceHospitalAccess('company', 'user', request('nomina/empleados', 'POST'))).resolves.toBeUndefined();
    member.hospitalPaginas = ['caja'];
    await expect(enforceHospitalAccess('company', 'user', request('nomina/aguinaldo'))).rejects.toMatchObject({ status: 403 });
  });
  it('requisiciones, órdenes and treasury are gated by their pages', async () => {
    member.hospitalPaginas = ['requisiciones'];
    await expect(enforceHospitalAccess('company', 'user', request('requisiciones', 'POST'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('ordenes'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('proveedores'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('tesoreria'))).rejects.toMatchObject({ status: 403 });
    member.hospitalPaginas = ['tesoreria'];
    await expect(enforceHospitalAccess('company', 'user', request('flujo'))).resolves.toBeUndefined();
    await expect(enforceHospitalAccess('company', 'user', request('ordenes'))).resolves.toBeUndefined();
  });
});

describe('combinarPermisos', () => {
  it('guardar el grupo de operación conserva los clínicos', () => {
    expect(combinarPermisos(['CLINICA_LEER', 'PRESCRIBIR', 'FINANZAS_ESCRIBIR'], ['COMPRAS_AUTORIZAR'], 'operacion').sort())
      .toEqual(['CLINICA_LEER', 'COMPRAS_AUTORIZAR', 'PRESCRIBIR']);
  });
  it('guardar el grupo clínico conserva los de operación', () => {
    expect(combinarPermisos(['CLINICA_LEER', 'PAGOS_AUTORIZAR'], [], 'clinicos')).toEqual(['PAGOS_AUTORIZAR']);
  });
  it('rechaza una llave de otro grupo', () => {
    expect(() => combinarPermisos([], ['TESORERIA_PAGAR'], 'clinicos')).toThrow(/no pertenece/);
  });
  it('sin grupo reemplaza la lista completa; con grupo descarta llaves desconocidas', () => {
    expect(combinarPermisos(['CLINICA_LEER'], ['ALTA', 'ALTA'])).toEqual(['ALTA']);
    expect(combinarPermisos(['LEGADO', 'ALTA'], [], 'operacion')).toEqual(['ALTA']);
  });
  it('los grupos cubren todas las llaves sin traslape', () => {
    expect([...permisosDelGrupo('clinicos'), ...permisosDelGrupo('operacion')].sort()).toEqual([...PERMISOS_CLINICOS].sort());
  });
});
