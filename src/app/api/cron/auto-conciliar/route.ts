import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/auto-conciliar
//
// El "contador AI" diario para bancos: corre la auto-conciliación de alta
// confianza para cada empresa activa. Sólo aplica coincidencias inequívocas
// (mismo umbral que el botón de conciliar). Idempotente — sólo toca
// transacciones UNMATCHED; nunca des-concilia. Barato (DB-only).
//
// Auth: secreto compartido en CRON_SECRET, pasado como
//   Authorization: Bearer <secret>   o   x-cron-secret: <secret>
//
// Query opcional: ?companyId=<id> para conciliar una sola empresa.
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
    : await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });

  const resultados = [];
  let errores = 0;
  let totalMatched = 0;
  for (const c of companies) {
    try {
      const res = await autoConciliarEmpresa(c.id);
      totalMatched += res.matched;
      resultados.push({ companyId: c.id, ...res });
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    companies: companies.length,
    totalMatched,
    errores,
    resultados,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
