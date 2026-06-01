import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { extractStatementFromDocument } from "@/lib/bancos/vision-statement";
import { persistTransactions } from "@/lib/bancos/import";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

const ALLOWED: Record<string, "application/pdf" | "image/jpeg" | "image/png" | "image/webp"> = {
  "application/pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

// POST /api/bancos/[id]/upload-pdf  (multipart/form-data, field "file")
//
// Vision-extracts a PDF/image estado de cuenta, validates the balance, and —
// only if it reconciles (or ?force=1) — imports the movimientos through the
// same dedup/categorize pipeline as CSV uploads. If the balance doesn't cuadrar
// we return the extraction + warnings WITHOUT importing, so the user can review.
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Extracción con IA no configurada" }, { status: 503 });
  }

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  let file: File | null = null;
  try {
    const formData = await req.formData();
    const f = formData.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Espera multipart/form-data con campo 'file'" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "Sube un archivo en el campo 'file'" }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "El archivo excede 15 MB" }, { status: 413 });

  const mediaType = ALLOWED[file.type];
  if (!mediaType) {
    return NextResponse.json({ error: "Formato no soportado. Usa PDF o imagen (JPG/PNG)." }, { status: 415 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  let extraction;
  try {
    extraction = await extractStatementFromDocument(buf, mediaType);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo procesar el documento" },
      { status: 502 }
    );
  }

  // Safety gate: don't import when the balance doesn't reconcile, unless forced.
  // SECURITY/CORRECTNESS: the raw document is NOT persisted — only the
  // structured rows once the user confirms.
  const needsReview = extraction.balanceCheck.cuadra === false;
  if ((needsReview || extraction.transactions.length === 0) && !force) {
    return NextResponse.json({
      ok: false,
      imported: 0,
      skipped: 0,
      needsReview: true,
      extraction,
      message:
        extraction.transactions.length === 0
          ? "No se detectaron movimientos. Revisa el archivo."
          : "La validación de saldos no cuadró. Revisa los movimientos y vuelve a enviar con confirmación.",
    }, { status: 200 });
  }

  const { imported, skipped } = await persistTransactions({
    bankAccountId,
    companyId: account.companyId,
    transactions: extraction.transactions,
    source: "UPLOAD_PDF",
  });

  return NextResponse.json({
    ok: true,
    imported,
    skipped,
    detectedBank: extraction.banco,
    balanceCheck: extraction.balanceCheck,
    warnings: extraction.warnings,
    message: `${imported} movimiento(s) importados${skipped > 0 ? `, ${skipped} ya existían` : ""}.`,
  });
}
