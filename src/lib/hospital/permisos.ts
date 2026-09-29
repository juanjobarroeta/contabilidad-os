import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership } from "@/lib/authz";

export const PERMISOS_CLINICOS = ["CLINICA_LEER", "CLINICA_ESCRIBIR", "ADMINISTRAR", "ALTA", "PRESCRIBIR", "FINANZAS_ESCRIBIR"] as const;
export type PermisoClinico = typeof PERMISOS_CLINICOS[number];

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
  cartera: ["cuentas", "panel"], contactos: ["clientes", "proveedores"], liquidaciones: ["medicos"], depositos: ["cuentas", "caja"], cobros: ["caja"], afiliaciones: ["convenios", "pacientes"], empleados: ["nomina"], buscar: ["pacientes", "episodios"], "validar-curp": ["pacientes", "medicos"],
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
    throw new AuthzError(403, "Sin acceso a esta función del hospital");
  }
  if (["usuarios", "cumplimiento"].includes(root) || (root === "config" && writing)) {
    if (!admin) throw new AuthzError(403, "Esta función requiere administración del hospital");
  }
  if (writing && ["cuentas", "caja", "depositos", "cobros", "bancos", "contabilidad", "liquidaciones"].includes(root)) {
    if (membership.role === "VIEWER" || !member?.hospitalPermisos.includes("FINANZAS_ESCRIBIR")) throw new AuthzError(403, "Falta permiso de operaciones financieras: FINANZAS_ESCRIBIR");
  }
  const clinical = ["pacientes", "episodios", "documentos", "saeh", "buscar", "censo", "citas", "planes", "panel", "registros"].includes(root) || (root === "farmacia" && ["kardex", "libro-control"].includes(path[1]));
  if (clinical) {
    const permission = writing ? (path.includes("aplicar-insumo") ? "ADMINISTRAR" : "CLINICA_ESCRIBIR") : "CLINICA_LEER";
    if (!(admin && !writing) && !member?.hospitalPermisos.includes(permission)) {
      throw new AuthzError(403, `Falta permiso clínico: ${permission}`);
    }
    if (writing && membership.role === "VIEWER") throw new AuthzError(403, "Cuenta de sólo lectura");
  }
}

export async function requireClinicalPermission(companyId: string, userId: string, permission: PermisoClinico) {
  const member = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId, companyId } } });
  if (!member || member.role === "VIEWER" || !member.hospitalPermisos.includes(permission)) {
    throw new AuthzError(403, `Falta permiso clínico: ${permission}`);
  }
}

export async function requirePractitioner(companyId: string, userId: string, requestedId?: string | null) {
  const medico = await prisma.hospMedico.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (!medico?.activo || !medico.credencialVerificadaAt || !medico.credencialEvidencia || !medico.cedula || (requestedId && requestedId !== medico.id)) {
    throw new AuthzError(403, "La autoría médica requiere un profesional activo, vinculado a tu usuario y con credencial verificada");
  }
  return medico;
}
