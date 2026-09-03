// Resumen de uso de IA del mes para las empresas que un usuario administra:
// alimenta la sección «Uso de inteligencia artificial» de Configuración →
// Facturación. Antes el gasto de IA sólo lo veía el operador en /rentabilidad;
// el despacho o el dueño no tenían forma de saber cuánto llevaban ni por qué
// se les bloqueaba el asistente.
import { prisma } from "@/lib/prisma";
import { estadoIAEmpresa, type EstadoIAEmpresa } from "./guardia";

export type UsoIAEmpresa = EstadoIAEmpresa & {
  razonSocial: string;
  rfc: string;
  /** ¿El usuario puede comprar uso extra para esta empresa (OWNER/ADMIN)? */
  puedeAmpliar: boolean;
};

/**
 * Empresas donde el usuario es OWNER/ADMIN directo, o miembro del despacho
 * dueño (todas las del despacho). Sólo empresas activas.
 */
export async function usoIAEmpresasDeUsuario(userId: string): Promise<UsoIAEmpresa[]> {
  const empresas = await prisma.company.findMany({
    where: {
      isActive: true,
      OR: [
        { members: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } } },
        { despacho: { members: { some: { userId } } } },
      ],
    },
    select: {
      id: true,
      razonSocial: true,
      rfc: true,
      members: { where: { userId }, select: { role: true } },
      despacho: { select: { members: { where: { userId }, select: { role: true } } } },
    },
    orderBy: { razonSocial: "asc" },
    take: 60,
  });

  const out: UsoIAEmpresa[] = [];
  for (const e of empresas) {
    const estado = await estadoIAEmpresa(e.id);
    if (!estado) continue;
    const rolDirecto = e.members[0]?.role;
    const rolDespacho = e.despacho?.members[0]?.role;
    const puedeAmpliar =
      rolDirecto === "OWNER" || rolDirecto === "ADMIN" || rolDespacho === "OWNER" || rolDespacho === "ADMIN";
    out.push({ ...estado, razonSocial: e.razonSocial, rfc: e.rfc, puedeAmpliar });
  }
  return out;
}
