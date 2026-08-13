import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { claveCuenta, type ClaseAjuste } from "@/lib/fiscal/ajuste-inflacion";
import { cargarAjusteInflacion } from "@/lib/fiscal/ajuste-inflacion-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fiscal/ajuste-inflacion?companyId=xxx&ejercicio=2025[&overrides=...]
//
// Ajuste anual por inflación (Arts. 44-46 LISR) derivado del LEDGER: el saldo
// al último día de cada mes de cada cuenta de balance da el saldo promedio
// anual que pide el Art. 44 frac. I.
//
// `overrides` es JSON —{ "107.01": "EXCLUIDA", ... }— la reclasificación que
// hace el contador cuando la ley depende de hechos que el catálogo no conoce
// (si un deudor diverso es un socio, Art. 45 frac. III).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

function parseOverrides(raw: string | null): Record<string, ClaseAjuste> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ClaseAjuste> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === "CREDITO" || v === "DEUDA" || v === "EXCLUIDA") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const ejercicio = parseInt(url.searchParams.get("ejercicio") ?? "", 10);
    if (!companyId || !Number.isFinite(ejercicio)) {
      return NextResponse.json({ error: "companyId y ejercicio requeridos" }, { status: 400 });
    }
    await requireMembership(companyId, undefined, req);

    const overrides = parseOverrides(url.searchParams.get("overrides"));
    const { resultado } = await cargarAjusteInflacion(companyId, ejercicio, overrides);

    // Sólo las cuentas con algo que mostrar: un catálogo completo son cientos
    // de filas en cero que esconden las cinco que mueven la cifra.
    const conSaldo = resultado.cuentas.filter(
      (c) => c.saldosMensuales.some((s) => s !== 0) || overrides[claveCuenta(c.cuentaSAT, c.subcuenta)]
    );

    return NextResponse.json({ ...resultado, cuentas: conSaldo, cuentasTotales: resultado.cuentas.length });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
