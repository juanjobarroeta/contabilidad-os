import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

/**
 * Carga una conversación y resuelve el acceso del usuario:
 * - El dueño la ve siempre (cualquier visibilidad).
 * - Si es COMPANY, cualquier miembro de la empresa la ve y puede continuarla.
 * Mutar (renombrar / cambiar visibilidad / borrar) queda restringido al dueño.
 */
export async function loadAccessibleConversation(id: string, userId: string) {
  const conv = await prisma.chatConversation.findUnique({ where: { id } });
  if (!conv) return { conv: null, isOwner: false, canView: false };
  const isOwner = conv.userId === userId;
  let canView = isOwner;
  if (!canView && conv.visibility === "COMPANY") {
    const member = await getEffectiveCompanyMembership(userId, conv.companyId);
    canView = !!member;
  }
  return { conv, isOwner, canView };
}
