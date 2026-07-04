import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { previewPtu, crearCorridaPtu } from "@/lib/nomina/corridas-especiales";

// ─────────────────────────────────────────────────────────────────────────────
// Corrida especial de PTU de un toque (Arts. 117-131 LFT / 123 CPEUM).
//
// El contador captura el MONTO TOTAL a repartir (renglón de PTU de la
// declaración anual — 10% de la renta gravable, Art. 120 LFT) y se reparte
// conforme al Art. 123 LFT: mitad por días trabajados, mitad por salarios
// devengados en el ejercicio, con tope individual de 3 meses de salario o el
// promedio de PTU de los últimos 3 años, lo más favorable (Art. 127 fracc.
// VIII, reforma DOF 23-abr-2021). Se excluyen automáticamente los empleados
// con menos de 60 días trabajados (Art. 127 fracc. VII); los directores,
// administradores y gerentes generales (fracc. I) se excluyen MANUALMENTE en
// la vista previa — el modelo no tiene esa bandera.
//
// GET  /api/nomina/run/ptu?companyId&ejercicio&montoTotal&fechaPago&excluir=a,b
//      → vista previa del reparto (recalcula la distribución al excluir).
// POST /api/nomina/run/ptu
//      { companyId, ejercicio, montoTotal, fechaPago?,
//        items: [{ employeeId, monto? }] }
//      → crea la corrida tipo PTU. El reparto se recalcula en el servidor
//        sobre el roster incluido; `monto` presente = ajuste manual (la
//        exención de 15 UMA y el ISR los rehace el motor).
// ─────────────────────────────────────────────────────────────────────────────

function parseEjercicio(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null;
}

function parseFechaPago(v: unknown): Date | null | undefined {
  if (v == null || v === "") return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const ejercicio = parseEjercicio(sp.get("ejercicio"));
  if (!ejercicio) return NextResponse.json({ error: "ejercicio inválido" }, { status: 400 });

  const montoTotal = Number(sp.get("montoTotal"));
  if (!Number.isFinite(montoTotal) || montoTotal <= 0) {
    return NextResponse.json({ error: "montoTotal debe ser mayor a cero" }, { status: 400 });
  }

  const fechaPago = parseFechaPago(sp.get("fechaPago"));
  if (fechaPago === null) return NextResponse.json({ error: "fechaPago inválida" }, { status: 400 });

  const excluirIds = (sp.get("excluir") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const preview = await previewPtu({ companyId, ejercicio, montoTotal, fechaPago, excluirIds });
  return NextResponse.json(preview);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId } = body;
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const ejercicio = parseEjercicio(body.ejercicio);
  if (!ejercicio) return NextResponse.json({ error: "ejercicio inválido" }, { status: 400 });

  const montoTotal = Number(body.montoTotal);
  if (!Number.isFinite(montoTotal) || montoTotal <= 0) {
    return NextResponse.json({ error: "montoTotal debe ser mayor a cero" }, { status: 400 });
  }

  const fechaPago = parseFechaPago(body.fechaPago);
  if (fechaPago === null) return NextResponse.json({ error: "fechaPago inválida" }, { status: 400 });

  const items = Array.isArray(body.items)
    ? (body.items as { employeeId?: unknown; monto?: unknown }[]).map((i) => ({
        employeeId: String(i.employeeId ?? ""),
        monto: i.monto != null ? Number(i.monto) : undefined,
      }))
    : [];
  if (items.length === 0 || items.some((i) => !i.employeeId)) {
    return NextResponse.json({ error: "items requeridos: [{ employeeId, monto? }]" }, { status: 400 });
  }

  const result = await crearCorridaPtu({ companyId, ejercicio, montoTotal, fechaPago, items });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
