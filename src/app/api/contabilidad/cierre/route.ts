import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { generarCierre, CierreError } from "@/lib/contabilidad/cierre";

// POST /api/contabilidad/cierre   body: { companyId, year }
// Genera el asiento de cierre del ejercicio (mes 13): cancela ingresos/costos/
// gastos contra Resultado del ejercicio. Idempotente (reemplaza el cierre previo).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { companyId } = body ?? {};
    const year = parseInt(String(body?.year ?? ""));
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    await requireWriter(companyId, req);
    const result = await generarCierre(companyId, year);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof CierreError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
