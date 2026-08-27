import { NextResponse } from "next/server";
import { AuthzError, requireWriter, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { naturalezaPorTipo } from "@/lib/contabilidad/coe-saldos";
import { postApertura, AperturaError } from "@/lib/contabilidad/apertura";
import { PeriodoCerradoError } from "@/lib/contabilidad/ejercicio";

// GET /api/contabilidad/apertura?companyId=xxx
// Cuentas del catálogo + el saldo de apertura actual de cada una (si existe),
// para alimentar la pantalla de captura de saldos iniciales.
export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    await requireMembership(companyId);

    const [accounts, apertura] = await Promise.all([
      prisma.chartAccount.findMany({
        where: { companyId, isActive: true },
        select: { cuentaSAT: true, subcuenta: true, nombre: true, nivel: true, tipo: true, naturaleza: true },
        orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
      }),
      prisma.accountingEntry.findMany({
        where: { companyId, fuente: "APERTURA" },
        select: { fecha: true, tipo: true, monto: true, chartAccount: { select: { cuentaSAT: true, subcuenta: true } } },
      }),
    ]);

    // Saldo de apertura actual por código (signo natural).
    const saldoPorCodigo = new Map<string, { cargo: number; abono: number }>();
    let fecha: string | null = null;
    for (const e of apertura) {
      const codigo = e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT;
      const s = saldoPorCodigo.get(codigo) ?? { cargo: 0, abono: 0 };
      if (e.tipo === "CARGO") s.cargo += Number(e.monto);
      else s.abono += Number(e.monto);
      saldoPorCodigo.set(codigo, s);
      if (!fecha) fecha = e.fecha.toISOString().slice(0, 10);
    }

    const cuentas = accounts.map((a) => {
      const codigo = a.subcuenta ?? a.cuentaSAT;
      const naturaleza = (a.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(a.tipo);
      const s = saldoPorCodigo.get(codigo);
      const saldo = s ? (naturaleza === "D" ? s.cargo - s.abono : s.abono - s.cargo) : 0;
      return { codigo, nombre: a.nombre, nivel: a.nivel, tipo: a.tipo, naturaleza, saldo };
    });

    return NextResponse.json({ fecha, cuentas });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

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
    if (e instanceof PeriodoCerradoError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
