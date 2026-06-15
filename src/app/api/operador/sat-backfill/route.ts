import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { getSatSyncStatus } from "@/lib/sat-status";

// ─────────────────────────────────────────────────────────────────────────────
// Operator-only: inspect and (re)arm a single company's HISTORICAL CFDI backfill.
//
// The incremental cron (/api/cron/sat-sync) only covers the last few months, so
// the prior year a company needs for its ISR coeficiente comes from the
// historical backfill (/api/cron/sat-backfill). That cron is gated and throttled
// by SAT's per-RFC quota and walks newest-first, so a company can have the
// current year imported while a prior year is still pending — or never armed.
//
// GET  ?rfc=… | ?companyId=…   → read getSatSyncStatus (no mutation)
// POST { rfc | companyId, years? }  → ensure autoSyncEnabled, bump satBackfillYears
//   (never below current, never below 2 so the prior full year is covered), clear
//   satBackfillCompletedAt so the next cron run resumes/extends the walk, then
//   return the fresh status.
//
// This does NOT call SAT directly (that would trip the quota); it re-arms the
// company so the paced background cron picks it up.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCompany(rfc?: unknown, companyId?: unknown) {
  if (typeof companyId === "string" && companyId) {
    return prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, rfc: true, razonSocial: true, satBackfillYears: true, fielCer: true, autoSyncEnabled: true },
    });
  }
  if (typeof rfc === "string" && rfc.trim()) {
    return prisma.company.findFirst({
      where: { rfc: { equals: rfc.trim(), mode: "insensitive" } },
      select: { id: true, rfc: true, razonSocial: true, satBackfillYears: true, fielCer: true, autoSyncEnabled: true },
    });
  }
  return null;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const url = new URL(req.url);
  const company = await resolveCompany(url.searchParams.get("rfc"), url.searchParams.get("companyId"));
  if (!company) return NextResponse.json({ error: "Empresa no encontrada (usa rfc o companyId)" }, { status: 404 });

  const status = await getSatSyncStatus(company.id);
  return NextResponse.json({
    company: { id: company.id, rfc: company.rfc, razonSocial: company.razonSocial },
    tieneFiel: company.fielCer != null,
    autoSyncEnabled: company.autoSyncEnabled,
    status,
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const company = await resolveCompany(body?.rfc, body?.companyId);
  if (!company) return NextResponse.json({ error: "Empresa no encontrada (usa rfc o companyId)" }, { status: 404 });

  // The historical cron skips companies without FIEL — re-arming would be a no-op.
  if (company.fielCer == null) {
    return NextResponse.json(
      { error: "La empresa no tiene FIEL cargada — el backfill histórico de CFDIs requiere FIEL (Descarga Masiva)." },
      { status: 422 }
    );
  }

  const requested = Number.isInteger(body?.years) ? (body.years as number) : null;
  // Never shrink below what's configured, and ensure ≥ 2 so the prior full year
  // (the one the coeficiente needs) is always in range.
  const years = requested != null
    ? Math.min(7, Math.max(1, requested))
    : Math.max(2, company.satBackfillYears ?? 0);

  await prisma.company.update({
    where: { id: company.id },
    data: {
      satBackfillYears: years,
      satBackfillCompletedAt: null, // resume/extend the walk on the next cron run
      autoSyncEnabled: true,
    },
  });

  const status = await getSatSyncStatus(company.id);
  return NextResponse.json({
    ok: true,
    rearmed: true,
    company: { id: company.id, rfc: company.rfc, razonSocial: company.razonSocial },
    satBackfillYears: years,
    status,
    nota:
      "Re-armado. El cron /api/cron/sat-backfill (por hora) caminará los periodos faltantes " +
      "más antiguos respetando la cuota del SAT; el año previo puede tardar varias corridas.",
  });
}
