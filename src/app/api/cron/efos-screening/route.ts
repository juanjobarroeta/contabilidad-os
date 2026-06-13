import { NextResponse } from "next/server";
import { descargarListaEfos } from "@/lib/fiscal/efos/download";
import { screenAllCompaniesEfos, screenCompanyEfos } from "@/lib/fiscal/efos/service";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/efos-screening
//
// Descarga el listado 69-B del SAT y coteja TODAS las empresas (RFC propio +
// clientes/proveedores) contra la lista, persistiendo hallazgos (FiscalHallazgo).
// Idempotente — seguro a diario.
//
// Auth: secreto compartido en CRON_SECRET (Authorization: Bearer <s> o
// x-cron-secret). Query opcional: ?companyId=<id> para una sola empresa.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let lista;
  try {
    lista = await descargarListaEfos();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const only = new URL(req.url).searchParams.get("companyId");
  if (only) {
    return NextResponse.json({ ok: true, rfcsEnLista: lista.size, ...(await screenCompanyEfos(only, lista)) });
  }
  return NextResponse.json({ ok: true, ...(await screenAllCompaniesEfos(lista)) });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
