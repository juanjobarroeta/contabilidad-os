import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { importBankStatement } from "@/lib/bancos/import";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/upload  (sesión web O token de servicio Bearer)
// Body: { fileContent: string, filename: string }
//
// Thin wrapper over the shared importBankStatement helper. Same logic
// runs from /api/construccion/bank-accounts/[id]/upload (bearer auth)
// for bartiz. Bearer auth here lets ZionX upload statements into the
// shared source of truth.
export async function POST(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(user.id);
  if (gate) return gate;

  const { fileContent, filename, encoding } = await req.json();
  const result = await importBankStatement({
    bankAccountId,
    companyId: account.companyId,
    fileContent,
    filename,
    encoding: encoding === "base64" ? "base64" : "text",
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
