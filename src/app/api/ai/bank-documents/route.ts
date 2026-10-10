import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBancosAccess, sesionOBearer } from "@/lib/bancos/statements/access";
import { gateEscritura } from "@/lib/subscription";
import { uploadBankDocument } from "@/lib/bancos/statements/upload";
import { publicError } from "@/lib/bancos/statements/contract";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(req: Request) {
  const session = await sesionOBearer(req); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const form = await req.formData(), companyId = String(form.get("companyId") ?? ""), bankAccountId = String(form.get("bankAccountId") ?? "");
    const access = await requireBancosAccess(session.user.id, companyId);
    if (!access.canWrite) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
    const gate = await gateEscritura(session.user.id); if (gate) return gate;
    if (!await prisma.bankAccount.findFirst({ where: { id: bankAccountId, companyId }, select: { id: true } })) return NextResponse.json({ error: "Selecciona la cuenta de esta empresa." }, { status: 400 });
    const file = form.get("file"); if (!(file instanceof File)) return NextResponse.json({ error: "Archivo requerido." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "El archivo excede 15 MB." }, { status: 413 });
    if (!/\.(csv|txt|ofx|qfx|xlsx?|pdf|jpe?g|png|webp)$/i.test(file.name)) return NextResponse.json({ error: "Usa CSV, Excel, OFX, PDF o imagen." }, { status: 415 });
    const result = await uploadBankDocument({ companyId, bankAccountId, userId: session.user.id, filename: file.name, mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()), password: String(form.get("password") ?? ""), month: String(form.get("month") ?? "") || undefined });
    return NextResponse.json(result, { status: "needsPassword" in result && result.needsPassword ? 422 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409 }); }
}
