import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireOwner } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { kickCron } from "@/lib/cron-scheduler";
import { cargarEstadoAlta } from "@/lib/onboarding/estado-alta";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/onboarding/estado?companyId= — la pantalla 05 (Historial) y el chip
// / anillo que la sigue por la app. Todo sale de la base, nada se simula:
//   · meses   ← SatSyncRequest (EMITIDOS/RECIBIDOS) + facturas por mes
//   · capas   ← TaxDeclaration mensual presentada · CeBalanzaMes
//   · etapas  ← src/lib/onboarding/estado.ts (las 5 por factura)
//   · conteos ← CFDI, clientes (RFC distintos en INGRESO), proveedores (EGRESO)
//   · opinión ← último ComplianceSnapshot SAT_OPINION
//   · catálogo ← último CT de la CE aplicado (CeArchivo) · empleados activos
//   · estimación ← cuánto falta (rango), de la mediana real de respuesta del SAT
// (la consulta vive en lib/onboarding/estado-alta.ts).
// La UI lo lee cada 5 s mientras está en la pantalla.
//
// POST { companyId, anios: 1|3|5 } — «¿Cuántos años?»: ajusta satBackfillYears
// (el mismo ajuste que lee cron/sat-backfill) y le da un empujón.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const ANIOS_VALIDOS = [1, 3, 5];

function error(e: unknown) {
  if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
}

export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    await requireMembership(companyId, undefined, req);

    // La tarjeta de Hoy pregunta primero si vale la pena: una empresa con el
    // historial completo no paga la consulta pesada en cada visita.
    if (new URL(req.url).searchParams.get("soloSiCargando") === "1") {
      const c = await prisma.company.findUnique({ where: { id: companyId }, select: { satBackfillCompletedAt: true, fielCer: true } });
      if (!c?.fielCer || c.satBackfillCompletedAt) return NextResponse.json({ cargando: false });
    }
    const estado = await cargarEstadoAlta(companyId);
    if (!estado) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
    return NextResponse.json(estado);
  } catch (e) {
    return error(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { companyId?: string; anios?: number } | null;
    const companyId = typeof body?.companyId === "string" ? body.companyId : "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    if (!ANIOS_VALIDOS.includes(body?.anios as number)) return NextResponse.json({ error: "Años inválidos" }, { status: 400 });
    await requireOwner(companyId, req);
    await prisma.company.update({
      where: { id: companyId },
      // Subir los años reabre el backfill: el cron decide por los meses que faltan.
      data: { satBackfillYears: body!.anios, satBackfillCompletedAt: null },
    });
    kickCron("sat-backfill");
    // Los años también mandan sobre las declaraciones: el historial sale por ejercicio.
    kickCron("declaraciones-historico", 10_000, `companyId=${encodeURIComponent(companyId)}`);
    kickCron("cancelados-backfill", 15_000, `companyId=${encodeURIComponent(companyId)}&historicas=4`);
    return NextResponse.json({ ok: true, anios: body!.anios });
  } catch (e) {
    return error(e);
  }
}
