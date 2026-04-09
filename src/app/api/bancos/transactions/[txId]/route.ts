import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ txId: string }> };

// PATCH /api/bancos/transactions/[txId]
// Body: { action: "match" | "unmatch" | "ignore" | "unignore", invoiceId?, notes? }
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { txId } = await params;
  const tx = await prisma.bankTransaction.findUnique({ where: { id: txId } });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, tx.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { action, invoiceId, notes } = await req.json();

  let data: Record<string, unknown> = {};

  switch (action) {
    case "match":
      if (!invoiceId) return NextResponse.json({ error: "invoiceId requerido para conciliar" }, { status: 400 });
      data = { status: "MATCHED", invoiceId, notes: notes ?? null };
      break;
    case "unmatch":
      data = { status: "UNMATCHED", invoiceId: null, notes: null };
      break;
    case "ignore":
      data = { status: "IGNORED", invoiceId: null, notes: notes ?? null };
      break;
    case "unignore":
      data = { status: "UNMATCHED", notes: null };
      break;
    default:
      return NextResponse.json({ error: `Acción desconocida: ${action}` }, { status: 400 });
  }

  const updated = await prisma.bankTransaction.update({
    where: { id: txId },
    data,
    include: {
      invoice: { select: { id: true, uuid: true, total: true, customer: { select: { razonSocial: true } } } },
    },
  });

  return NextResponse.json(updated);
}
