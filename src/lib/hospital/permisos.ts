import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership } from "@/lib/authz";
import { DEMO_CEDULA, demoMedicalGrant, isDemoPatient } from "./demo";

export const PERMISOS_CLINICOS = ["CLINICA_LEER", "CLINICA_ESCRIBIR", "ADMINISTRAR", "ALTA", "PRESCRIBIR", "FINANZAS_ESCRIBIR", "COMPRAS_AUTORIZAR", "PAGOS_AUTORIZAR", "TESORERIA_PAGAR"] as const;
export type PermisoClinico = typeof PERMISOS_CLINICOS[number];

// Dos grupos que se administran por separado en Usuarios: lo clínico (va con
// la identidad médica verificada) y lo de operación (dinero, compras, pagos).
// Guardar un grupo nunca toca el otro.
export const PERMISOS_OPERACION = ["FINANZAS_ESCRIBIR", "COMPRAS_AUTORIZAR", "PAGOS_AUTORIZAR", "TESORERIA_PAGAR"] as const satisfies readonly PermisoClinico[];
export type GrupoPermisos = "clinicos" | "operacion";

export function permisosDelGrupo(grupo: GrupoPermisos): PermisoClinico[] {
  const op = new Set<string>(PERMISOS_OPERACION);
  return PERMISOS_CLINICOS.filter((p) => (grupo === "operacion") === op.has(p));
}

/**
 * Reemplaza sólo las llaves de `grupo`; las del otro grupo se conservan tal
 * como están. Sin grupo, `nuevos` es la lista completa (compatibilidad).
 * Lanza 400 si `nuevos` trae una llave de otro grupo.
 */
export function combinarPermisos(actuales: readonly string[], nuevos: readonly PermisoClinico[], grupo?: GrupoPermisos): PermisoClinico[] {
  if (!grupo) return [...new Set(nuevos)];
  const delGrupo = new Set<string>(permisosDelGrupo(grupo));
  const ajena = nuevos.find((p) => !delGrupo.has(p));
  if (ajena) throw new AuthzError(400, `El permiso ${ajena} no pertenece a este grupo`);
  const validos = new Set<string>(PERMISOS_CLINICOS);
  const conservados = actuales.filter((p) => validos.has(p) && !delGrupo.has(p)) as PermisoClinico[];
  return [...new Set([...conservados, ...nuevos])];
}

const ACCION_POR_PERMISO: Record<PermisoClinico, string> = {
  CLINICA_LEER: "consultar expedientes clínicos",
  CLINICA_ESCRIBIR: "escribir o modificar información clínica",
  ADMINISTRAR: "registrar la aplicación de medicamentos o insumos",
  ALTA: "dar de alta a pacientes",
  PRESCRIBIR: "registrar indicaciones médicas",
  FINANZAS_ESCRIBIR: "registrar o modificar operaciones financieras",
  COMPRAS_AUTORIZAR: "autorizar requisiciones de compra",
  PAGOS_AUTORIZAR: "autorizar pagos a proveedores",
  TESORERIA_PAGAR: "registrar pagos de tesorería",
};
function mensajeSinPermiso(permission: PermisoClinico) {
  return `Tu usuario no tiene permiso para ${ACCION_POR_PERMISO[permission]} en este hospital. Pide a un administrador que habilite este acceso en Usuarios.`;
}

const paginas: Record<string, string[]> = {
  registros: ["registros", "episodios"],
  pacientes: ["pacientes", "episodios"], episodios: ["episodios"], documentos: ["episodios", "pacientes"],
  citas: ["agenda"], recursos: ["censo", "agenda", "episodios"], censo: ["censo"],
  farmacia: ["farmacia", "episodios"], medicos: ["medicos", "episodios", "agenda"],
  cuentas: ["cuentas"], cotizaciones: ["cotizaciones"], pagadores: ["convenios", "cotizaciones", "episodios"],
  protocolos: ["protocolos"], planes: ["protocolos", "episodios"], saeh: ["saeh"],
  mantenimiento: ["mantenimiento"], compras: ["compras"], caja: ["caja"],
  usuarios: ["usuarios"], config: ["configuracion"], cumplimiento: ["cumplimiento"],
  contabilidad: ["contabilidad"], fiscal: ["impuestos"], bancos: ["bancos"], nomina: ["nomina"],
  cartera: ["cuentas", "panel"], facturacion: ["facturacion", "caja", "cuentas"], contactos: ["clientes", "proveedores"], liquidaciones: ["caja", "bancos"], depositos: ["cuentas", "caja"], cobros: ["caja"], afiliaciones: ["convenios", "pacientes", "caja", "bancos"], empleados: ["nomina"], buscar: ["pacientes", "episodios"], "validar-curp": ["pacientes", "medicos"],
  proveedores: ["proveedores", "compras", "requisiciones", "tesoreria", "medicos"],
  requisiciones: ["requisiciones", "compras", "tesoreria"], ordenes: ["requisiciones", "compras", "tesoreria"],
  tesoreria: ["tesoreria"], flujo: ["tesoreria", "panel"],
  panel: ["panel", "alertas"], alertas: ["alertas"], servicios: ["convenios", "cotizaciones", "cuentas"],
  catalogos: ["episodios", "pacientes", "saeh", "medicos"],
};

/** Enforced before module-level operator/despacho shortcuts. Clinical grants are explicit. */
export async function enforceHospitalAccess(companyId: string, userId: string, req: Request) {
  const { membership } = await requireMembership(companyId, undefined, req);
  const member = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId, companyId } } });
  const path = new URL(req.url).pathname.split("/").filter(Boolean).slice(2);
  let root = path[0];
  if (root === "episodios" && ["cuenta", "cargos", "depositos"].includes(path[2])) root = "cuentas";
  if (root === "cotizaciones" && path.includes("convertir")) root = "episodios";
  const admin = ["OWNER", "ADMIN"].includes(membership.role);
  const writing = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!(root === "config" && !writing) && member?.hospitalPaginas.length && !(paginas[root] ?? [root]).some(p => member.hospitalPaginas.includes(p))) {
    throw new AuthzError(403, "Tu usuario no tiene acceso a esta sección del hospital. Pide a un administrador que habilite esta sección en Usuarios.");
  }
  if (["usuarios", "cumplimiento"].includes(root) || (root === "config" && writing)) {
    if (!admin) throw new AuthzError(403, "Sólo un administrador del hospital puede realizar esta acción. Contacta al administrador de tu hospital.");
  }
  if (writing && ["cuentas", "caja", "depositos", "cobros", "bancos", "contabilidad", "liquidaciones", "facturacion", "nomina", "tesoreria"].includes(root)) {
    if (membership.role === "VIEWER" || !member?.hospitalPermisos.includes("FINANZAS_ESCRIBIR")) throw new AuthzError(403, mensajeSinPermiso("FINANZAS_ESCRIBIR"));
  }
  const clinical = ["pacientes", "episodios", "documentos", "saeh", "buscar", "censo", "citas", "planes", "panel", "registros"].includes(root) || (root === "farmacia" && ["kardex", "libro-control"].includes(path[1]));
  if (clinical) {
    const permission = writing ? (path.includes("aplicar-insumo") ? "ADMINISTRAR" : "CLINICA_ESCRIBIR") : "CLINICA_LEER";
    if (!(admin && !writing) && !member?.hospitalPermisos.includes(permission)) {
      throw new AuthzError(403, mensajeSinPermiso(permission));
    }
    if (writing && membership.role === "VIEWER") throw new AuthzError(403, "Tu usuario sólo puede consultar información. Para guardar cambios, pide acceso de escritura al administrador de tu hospital.");
  }
}

export async function requireClinicalPermission(companyId: string, userId: string, permission: PermisoClinico) {
  const member = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId, companyId } } });
  if (!member || member.role === "VIEWER" || !member.hospitalPermisos.includes(permission)) {
    throw new AuthzError(403, mensajeSinPermiso(permission));
  }
}

export async function requirePractitioner(companyId: string, userId: string, requestedId?: string | null, pacienteId?: string) {
  const medico = await prisma.hospMedico.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (medico?.activo && medico.cedula === DEMO_CEDULA && (!requestedId || requestedId === medico.id)) {
    const grant = await demoMedicalGrant(companyId, userId);
    if (pacienteId && grant?.medicoId === medico.id && grant.pacienteIds.includes(pacienteId) && await isDemoPatient(companyId, pacienteId)) {
      return { ...medico, soloDemostracion: true };
    }
    throw new AuthzError(403, "Tu acceso médico de demostración sólo permite firmar en el paciente DEMO habilitado. Abre su expediente para continuar la demostración. Para atender pacientes reales, un administrador debe verificar tu identidad profesional.");
  }
  if (!medico?.activo || medico.cedula === DEMO_CEDULA || !medico.credencialVerificadaAt || !medico.credencialEvidencia || !medico.cedula || (requestedId && requestedId !== medico.id)) {
    throw new AuthzError(403, "No puedes firmar como médico con este usuario. Un administrador debe vincular tu cuenta a tu perfil médico y verificar tu cédula en Usuarios. Si ya tienes un perfil verificado, debes firmar con tu propia identidad.");
  }
  return { ...medico, soloDemostracion: false };
}
