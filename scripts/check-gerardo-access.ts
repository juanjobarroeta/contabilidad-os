import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const user = await p.user.findFirst({
    where: { email: "gdecolombres@decolsa.com" },
    select: {
      id: true,
      email: true,
      memberships: {
        select: {
          companyId: true,
          role: true,
          allowedModules: true,
          company: {
            select: { rfc: true, razonSocial: true, modules: { where: { habilitado: true }, select: { modulo: true } } },
          },
        },
      },
      despachoMemberships: {
        select: {
          role: true,
          despacho: {
            select: {
              name: true,
              companies: {
                select: { id: true, rfc: true, razonSocial: true, modules: { where: { habilitado: true }, select: { modulo: true } } },
              },
            },
          },
          companyScopes: { select: { companyId: true } },
        },
      },
    },
  });
  console.log(JSON.stringify(user, null, 2));
}

main().finally(() => p.$disconnect());
