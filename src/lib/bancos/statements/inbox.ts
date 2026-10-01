import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { StatementImport } from "./ingest";
export type InboxMetadata = Pick<StatementImport, "saldoInicial" | "saldoFinal" | "holdForReview" | "declaredAccount" | "declaredCurrency" | "periodStart" | "periodEnd" | "controls" | "warnings" | "cuadro">;
export async function stageBankOriginal(companyId: string, bytes: Buffer, filename: string, mime: string, metadata: InboxMetadata = {}) {
  if (bytes.length > 15 * 1024 * 1024) throw new Error("El archivo excede 15 MB.");
  await prisma.bankDocumentInbox.deleteMany({ where: { companyId, expiresAt: { lt: new Date() } } });
  const row = await prisma.bankDocumentInbox.create({ data: { companyId, bytes: new Uint8Array(bytes), filename, mime,
    metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + 86400000) }, select: { id: true } });
  return row.id;
}
export async function readBankOriginal(companyId: string, id: string) {
  const row = await prisma.bankDocumentInbox.findFirst({ where: { id, companyId, expiresAt: { gt: new Date() } } });
  if (!row) throw new Error("El documento pendiente expiró o no pertenece a esta empresa. Envíalo otra vez.");
  return { ...(row.metadata as InboxMetadata), archivo: { bytes: row.bytes, nombre: row.filename, mime: row.mime } };
}
