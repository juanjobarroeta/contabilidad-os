import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { importBankStatement } from "@/lib/bancos/import";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/upload  (session-cookie auth)
// Body: { fileContent: string, filename: string }
//
// Thin wrapper over the shared importBankStatement helper. Same logic
// runs from /api/construccion/bank-accounts/[id]/upload (bearer auth)
// for bartiz.
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { fileContent, filename } = await req.json();
  const result = await importBankStatement({
    bankAccountId,
    companyId: account.companyId,
    fileContent,
    filename,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
