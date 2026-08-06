import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthzError, requireWriter } from "@/lib/authz";
import { postMonth, unpostMonth } from "@/lib/contabilidad/posting";
import { PeriodoCerradoError } from "@/lib/contabilidad/ejercicio";

const postSchema = z.object({
  companyId: z.string().min(1),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

// POST /api/contabilidad/post
// Body: { companyId, year, month }
// Runs the posting engine and returns the result. Safe to call repeatedly —
// the engine wipes prior entries for the period first.
export async function POST(req: Request) {
  try {
    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
    }
    const { companyId, year, month } = parsed.data;

    await requireWriter(companyId);

    const result = await postMonth({ companyId, year, month });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof PeriodoCerradoError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error al cerrar el mes";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/contabilidad/post?companyId=xxx&year=2026&month=3
// Re-opens a period by deleting all its entries and setting status back to DRAFT.
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    if (!companyId || !year || !month) {
      return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
    }

    await requireWriter(companyId);

    await unpostMonth(companyId, year, month);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof PeriodoCerradoError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
