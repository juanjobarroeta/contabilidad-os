import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Same active-company grants as the company selector, including scoped firms. */
export async function accessibleCompaniesWhere(
  userId: string,
  db: Pick<Prisma.TransactionClient, "user" | "despachoMember"> = prisma,
): Promise<Prisma.CompanyWhereInput> {
  const [user, firm] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { esOperador: true } }),
    db.despachoMember.findUnique({
      where: { userId },
      select: { despachoId: true, companyScopes: { select: { companyId: true } } },
    }),
  ]);
  if (user?.esOperador) return { isActive: true };
  return {
    isActive: true,
    OR: [
      { members: { some: { userId } } },
      ...(firm ? [{
        despachoId: firm.despachoId,
        ...(firm.companyScopes.length ? { id: { in: firm.companyScopes.map((s) => s.companyId) } } : {}),
      }] : []),
    ],
  };
}
