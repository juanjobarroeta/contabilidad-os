import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { submitSatSync } from "@/lib/sat-sync";

// POST /api/sat/sync
// Body: { companyId, month, year, force? }
// Submits TWO requests to SAT (emitidos + recibidos) UNLESS we already have
// a recent pending/finished request for the same period — in which case we
// reuse the SAT requestId so we don't waste quota.
// Returns: { emitidosRequestId, recibidosRequestId, reusedEmitidos, reusedRecibidos }
//
// The actual SAT plumbing lives in @/lib/sat-sync (submitSatSync) so the same
// logic can be driven unattended by the background cron job.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, month, year, force } = body;

  if (!companyId || !month || !year) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED): la
  // descarga masiva consume cuota del SAT y escribe CFDIs en la cuenta.
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const result = await submitSatSync(companyId, year, month, !!force);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, warnings: result.warnings },
      { status: result.status }
    );
  }

  return NextResponse.json({
    emitidosRequestId: result.emitidosRequestId,
    recibidosRequestId: result.recibidosRequestId,
    reusedEmitidos: result.reusedEmitidos,
    reusedRecibidos: result.reusedRecibidos,
    month: result.month,
    year: result.year,
    message: result.message,
    warnings: result.warnings,
  });
}
