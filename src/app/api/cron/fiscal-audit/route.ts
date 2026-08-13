import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAuditForCompany } from "@/lib/fiscal/audit/service";
import { generarSintesisAuditoria } from "@/lib/fiscal/audit/sintesis";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/fiscal-audit
//
// The "24/7 contador": runs the fiscal auditor for every company and persists
// findings (FiscalHallazgo). Idempotent — safe to run on any cadence.
//
// Auth: shared secret in CRON_SECRET, passed as
//   Authorization: Bearer <secret>   or   x-cron-secret: <secret>
//
// Optional query: ?companyId=<id> to audit a single company.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("companyId");

  const companies = only
    ? [{ id: only }]
    : await prisma.company.findMany({ select: { id: true } });

  const resultados = [];
  let errores = 0;
  let sintesis = 0;
  for (const c of companies) {
    try {
      const r = await runAuditForCompany(c.id);
      resultados.push(r);
      // Síntesis ejecutiva: sólo cuando la corrida CAMBIÓ algo (o no existe
      // brief) — una corrida sin cambios no gasta tokens en re-narrar lo mismo.
      const cambio = r.nuevos > 0 || r.autoResueltos > 0;
      const tieneBrief = cambio
        ? true
        : (await prisma.auditBrief.count({ where: { companyId: c.id } })) > 0;
      if (cambio || !tieneBrief) {
        try {
          await generarSintesisAuditoria(c.id);
          sintesis++;
        } catch (e) {
          console.error("[cron/fiscal-audit] síntesis falló:", c.id, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    empresas: companies.length,
    errores,
    sintesisGeneradas: sintesis,
    resultados,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
