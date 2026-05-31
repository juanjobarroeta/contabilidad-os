import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { verifyAndImportSatSync } from "@/lib/sat-sync";

// POST /api/sat/sync/verify
// Body: { companyId, emitidosRequestId?, recibidosRequestId?, month, year }
// Returns: { status: "pending"|"done"|"empty"|"partial", imported?, message? }
//
// The actual verify/download/import work lives in @/lib/sat-sync
// (verifyAndImportSatSync) so it can also run unattended from the cron job.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, emitidosRequestId, recibidosRequestId } = body;

  if (!companyId || (!emitidosRequestId && !recibidosRequestId)) {
    return NextResponse.json({ error: "Faltan parámetros" }, { status: 400 });
  }

  // Verify membership
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const result = await verifyAndImportSatSync(companyId, emitidosRequestId, recibidosRequestId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    status: result.status,
    imported: result.imported,
    skipped: result.skipped,
    message: result.message,
  });
}
