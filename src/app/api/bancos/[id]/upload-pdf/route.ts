import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireBancosAccess } from "@/lib/bancos/statements/access";
import { gateEscritura } from "@/lib/subscription";
import { uploadBankDocument } from "@/lib/bancos/statements/upload";
import { publicError } from "@/lib/bancos/statements/contract";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth(); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id }, select: { companyId: true } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  try {
    const access = await requireBancosAccess(session.user.id, account.companyId);
    if (!access.canWrite) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
    const gate = await gateEscritura(session.user.id); if (gate) return gate;
    const form = await req.formData(), file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Selecciona un archivo." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "El archivo excede 15 MB." }, { status: 413 });
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) return NextResponse.json({ error: "Usa PDF o imagen." }, { status: 415 });
    const result = await uploadBankDocument({ companyId: account.companyId, bankAccountId: id, userId: session.user.id,
      bytes: Buffer.from(await file.arrayBuffer()), filename: file.name, mime: file.type, password: String(form.get("password") ?? ""),
      month: new URL(req.url).searchParams.get("mes") ?? new URL(req.url).searchParams.get("month") ?? undefined });
    return NextResponse.json(result, { status: "needsPassword" in result && result.needsPassword ? 422 : 200 });
  } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409 }); }
}
