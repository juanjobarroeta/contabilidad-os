import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireBancosAccess } from "@/lib/bancos/statements/access";
import { gateEscritura } from "@/lib/subscription";
import { accountReview, reviewPage, documentPage, previewReview, executeReview } from "@/lib/bancos/statements/review";
import { publicError, reviewRequestSchema, scopeSchema } from "@/lib/bancos/statements/contract";
import { autoVerificarEstado, estadosPorRevisar } from "@/lib/bancos/statements/auto-verify";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  const session = await auth(); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  // Estados por revisar de TODOS los meses y cuentas (no requiere periodo).
  if (p.get("pendientes") === "1") {
    const companyId = p.get("companyId") ?? "";
    try {
      const access = await requireBancosAccess(session.user.id, companyId);
      return NextResponse.json({ items: await estadosPorRevisar(companyId), canWrite: access.canWrite }, { headers: noStore });
    } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore }); }
  }
  const parsed = scopeSchema.safeParse({ companyId: p.get("companyId"), bankAccountId: p.get("bankAccountId"), year: Number(p.get("year")), month: Number(p.get("month")) });
  if (!parsed.success) return NextResponse.json({ error: "Cuenta y periodo requeridos." }, { status: 400 });
  try {
    const access = await requireBancosAccess(session.user.id, parsed.data.companyId);
    const review = await accountReview(parsed.data);
    const result = reviewPage(review, Number(p.get("cursor")) || 0, Number(p.get("limit")) || 50);
    const documentId = p.get("documentId");
    return NextResponse.json(documentId ? { ...documentPage(review, documentId, Number(p.get("cursor")) || 0), canWrite: access.canWrite } : { ...result, canWrite: access.canWrite }, { headers: noStore });
  } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore }); }
}
export async function POST(req: Request) {
  const session = await auth(); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  // Reintento de la verificación automática (p. ej. el mes ya terminó o se
  // resolvieron las filas pendientes). Mismos controles que la manual.
  if (body?.action === "auto") {
    const companyId = typeof body.companyId === "string" ? body.companyId : "", batchId = typeof body.batchId === "string" ? body.batchId : "";
    try {
      const access = await requireBancosAccess(session.user.id, companyId);
      if (!access.canWrite) return NextResponse.json({ error: "Sin permisos para confirmar." }, { status: 403 });
      const gate = await gateEscritura(session.user.id); if (gate) return gate;
      return NextResponse.json(await autoVerificarEstado(companyId, batchId, session.user.id), { headers: noStore });
    } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore }); }
  }
  const parsed = reviewRequestSchema.safeParse(body?.request);
  if (!parsed.success || !["preview", "confirm"].includes(body?.action)) return NextResponse.json({ error: "Solicitud de revisión inválida." }, { status: 400 });
  try {
    const access = await requireBancosAccess(session.user.id, parsed.data.companyId);
    if (!access.canWrite) return NextResponse.json({ error: "Sin permisos para confirmar." }, { status: 403 });
    const gate = await gateEscritura(session.user.id); if (gate) return gate;
    if (body.action === "confirm") return NextResponse.json(await executeReview(parsed.data, session.user.id), { headers: noStore });
    const p = await previewReview(parsed.data);
    return NextResponse.json({ summary: p.summary, expected: p.expected, effectExpected: p.effectHash, ledgerEffect: p.ledgerEffect }, { headers: noStore });
  } catch (e) { return NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore }); }
}
