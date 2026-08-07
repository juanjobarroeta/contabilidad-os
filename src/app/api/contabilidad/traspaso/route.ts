import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { generarTraspasoResultado, TraspasoError } from "@/lib/contabilidad/traspaso";
import { PeriodoCerradoError } from "@/lib/contabilidad/ejercicio";

// POST /api/contabilidad/traspaso   body: { companyId, year }
//
// Traspasa el resultado del ejercicio `year` (305.01) a resultados acumulados
// (304.01) con fecha 1-ene del ejercicio siguiente, para que el año nuevo
// arranque con 305.01 en cero. Idempotente: regenerarlo reemplaza el asiento
// anterior en vez de duplicarlo.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyId = body?.companyId as string | undefined;
    const year = parseInt(String(body?.year ?? ""));
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    await requireWriter(companyId, req);
    const result = await generarTraspasoResultado(companyId, year);
    return NextResponse.json({ ok: true, year, ...result });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof TraspasoError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof PeriodoCerradoError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
