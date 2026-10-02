import { prisma } from "@/lib/prisma";

export async function draftIdentity(companyId: string, customerId: string) {
  const [emisor, receptor] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } }),
    prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } }),
  ]);
  if (!emisor || !receptor) throw new Error("Emisor o receptor no disponible para esta empresa.");
  return { emisor, receptor };
}
