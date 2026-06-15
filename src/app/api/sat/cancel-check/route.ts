import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/sat/cancel-check  { companyId, monthsBack?, dryRun? }
//
// Pregunta al SAT (descarga de metadata) si las facturas de la empresa fueron
// canceladas y marca STAMPED→CANCELLED las que sí. A diferencia del cron 2x/día
// (que sólo mira los últimos 3 meses), aquí la ventana es configurable, para
// revisar bajo demanda una cancelación más antigua o confirmar una puntual.
//
// El SAT es ASÍNCRONO: en la primera llamada varios periodos pueden quedar
// "pending" (la solicitud de metadata se está procesando); se resuelven en una
// segunda llamada (reusa la solicitud dentro de 24h) o en la siguiente corrida
// del cron. dryRun=true reporta qué cancelaría sin escribir.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const companyId = body?.companyId;
  if (!companyId || typeof companyId !== "string") {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const monthsBack = Math.min(Math.max(parseInt(String(body?.monthsBack ?? "12"), 10) || 12, 1), 24);
  const dryRun = body?.dryRun === true;

  const now = new Date();
  let cancelled = 0;
  let checked = 0;
  let periodsPending = 0;
  const wouldCancel: { id: string; uuid: string }[] = [];
  const errors: string[] = [];

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const res = await syncCancelacionesPeriodo(companyId, d.getFullYear(), d.getMonth() + 1, dryRun);
    if (!res.ok) {
      if (res.error) errors.push(`${d.getFullYear()}-${d.getMonth() + 1}: ${res.error}`);
      continue;
    }
    if (res.status === "pending") periodsPending++;
    checked += res.checked ?? 0;
    cancelled += res.cancelled ?? 0;
    if (res.wouldCancel?.length) wouldCancel.push(...res.wouldCancel);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    monthsBack,
    checked,             // CFDIs revisados en el metadata
    cancelled,           // marcados CANCELLED (0 en dryRun)
    wouldCancel,         // sólo dryRun: UUIDs que se cancelarían
    periodsPending,      // periodos que el SAT sigue procesando — reintenta
  });
}
