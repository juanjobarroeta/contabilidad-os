import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const companies = await prisma.company.findMany({
  select: { id: true, rfc: true, razonSocial: true, modules: { select: { modulo: true, habilitado: true } } },
  orderBy: { createdAt: "asc" },
});
console.log(JSON.stringify(companies, null, 2));
await prisma.$disconnect();
