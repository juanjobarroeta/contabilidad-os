import { NextResponse } from "next/server";
import { generarResumenes } from "@/lib/fiscal-kb/resumenes";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/fiscal-resumenes
//
// Genera resúmenes por unidad legal (artículo / regla) para las unidades
// vigentes que aún no tienen uno (ver fiscal-kb/resumenes.ts). Incremental e
// idempotente; cada llamada procesa hasta `limit` unidades y devuelve
// `restantes` para que el workflow repita hasta cero.
//
// Auth: CRON_SECRET (Authorization: Bearer … o x-cron-secret).
// Body: { "limit"?: number (≤200, default 100), "concurrencia"?: number (≤16, default 8) }
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

export async function POST(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { limit?: number; concurrencia?: number };
  try {
    const r = await generarResumenes({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      concurrencia: typeof body.concurrencia === "number" ? body.concurrencia : undefined,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[fiscal-resumenes]", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
