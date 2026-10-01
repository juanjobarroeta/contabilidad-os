import { z } from "zod";
const id = z.string().min(1).max(120);
const reason = z.string().trim().min(8).max(1000);
const number = z.number().finite();
export const scopeSchema = z.object({ companyId: id, bankAccountId: id, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
export const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("row"), rowId: id, resolution: z.enum(["LINK", "NEW", "EXCLUDE", "REPLACE"]), movementId: id.optional(), reason }).strict(),
  z.object({ type: z.literal("pair"), primaryId: id, secondaryId: id, resolution: z.enum(["KEEP_BOTH", "MERGE"]), reason }).strict(),
  z.object({ type: z.literal("verify"), batchId: id, opening: number, closing: number, credits: number.nonnegative(), debits: number.nonnegative(),
    creditCount: z.number().int().nonnegative().nullable().optional(), debitCount: z.number().int().nonnegative().nullable().optional(), countsUnavailable: z.boolean(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accountConfirmed: z.boolean(), coverageConfirmed: z.boolean(), originalReviewed: z.boolean(), reason }).strict(),
  z.object({ type: z.literal("reopen"), batchId: id, reason }).strict(),
]);
export const reviewRequestSchema = scopeSchema.extend({ expected: z.string().length(64), effectExpected: z.string().length(64).optional(), operation: operationSchema }).strict();
export const publicError = (e: unknown) => e instanceof Error && !e.name.startsWith("Prisma") ? e.message : "No se pudo completar la revisión. Actualiza e intenta nuevamente.";
