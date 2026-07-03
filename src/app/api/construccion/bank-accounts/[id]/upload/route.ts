/**
 * POST /api/construccion/bank-accounts/[id]/upload
 *
 * Bearer-aware CSV/PDF-text upload for bartiz Tesorería. Reuses the
 * shared importBankStatement helper so dedup + parsing + auto-categorize
 * is identical to contabilidad-os's /api/bancos/[id]/upload. Same logic
 * = same behaviour from either UI.
 *
 * Body:
 *   { fileContent: string, filename: string }
 *
 * Returns:
 *   { ok, imported, skipped, posiblesDuplicados, descartadas: {fila, motivo}[],
 *     format, detectedBank, warnings, message }
 *
 * Dedup: re-importing the same statement file is idempotent — per key
 * (bankAccountId + same day fecha + same monto + same descripcion + same
 * referencia), if the file has F occurrences and the DB already has D,
 * max(0, F − D) get inserted and the rest are skipped as posibles
 * duplicados (ver src/lib/bancos/dedup.ts). Rows the parser could not
 * read are reported in `descartadas`, never dropped silently.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import { importBankStatement } from "@/lib/bancos/import";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: bankAccountId } = await ctx.params;
    const account = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, companyId: true },
    });
    if (!account) throw new AuthzError(404, "Cuenta no encontrada");
    await requireWriter(account.companyId, req);
    await requireModule(account.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const fileContent: string = body?.fileContent ?? "";
    const filename: string = body?.filename ?? "statement.csv";

    const result = await importBankStatement({
      bankAccountId,
      companyId: account.companyId,
      fileContent,
      filename,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  }
);
