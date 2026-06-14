import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { postApertura, AperturaError } from "@/lib/contabilidad/apertura";

// POST /api/contabilidad/apertura
// body: { companyId, fecha: "YYYY-MM-DD", lineas: [{ codigo, saldo }] }
// Captura los saldos iniciales (asiento de apertura) de una empresa que migra a
// media vida. saldo en signo natural de la cuenta. Debe cuadrar (Σ cargos = Σ abonos).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { companyId, fecha, lineas } = body ?? {};
    if (!companyId || !fecha || !Array.isArray(lineas)) {
      return NextResponse.json({ error: "companyId, fecha y lineas[] requeridos" }, { status: 400 });
    }

    await requireWriter(companyId, req);

    const limpias = lineas
      .map((l: { codigo?: unknown; saldo?: unknown }) => ({ codigo: String(l?.codigo ?? "").trim(), saldo: Number(l?.saldo) }))
      .filter((l: { codigo: string; saldo: number }) => l.codigo && Number.isFinite(l.saldo));

    const result = await postApertura(companyId, String(fecha), limpias);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof AperturaError) {
      return NextResponse.json({ error: e.message, diferencia: e.diferencia }, { status: 400 });
    }
    throw e;
  }
}
