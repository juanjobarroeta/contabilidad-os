import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  previewAguinaldo,
  crearCorridaAguinaldo,
} from "@/lib/nomina/corridas-especiales";
import { DIAS_AGUINALDO_MINIMO } from "@/lib/nomina/constants";

// ─────────────────────────────────────────────────────────────────────────────
// Corrida especial de AGUINALDO de un toque (Art. 87 LFT: mínimo 15 días de
// salario, proporcional para quien no cumplió el año, pagadero antes del
// 20-dic; exención de 30 UMA — Art. 93 fracc. XIV LISR).
//
// GET  /api/nomina/run/aguinaldo?companyId&ejercicio&diasAguinaldo&fechaPago
//      → vista previa por empleado ACTIVO (proporcionalidad por fecha de
//        alta, exención, ISR y neto estimados con el motor).
// POST /api/nomina/run/aguinaldo
//      { companyId, ejercicio, diasAguinaldo?, fechaPago?,
//        items?: [{ employeeId, monto? }] }
//      → crea la corrida tipo AGUINALDO (queda CALCULATED y sigue el flujo
//        normal de revisión → timbrado). `monto` presente = ajuste manual de
//        la vista previa; el motor recalcula exención e ISR al crear.
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

  const ejercicio = parseEjercicio(sp.get("ejercicio") ?? new Date().getFullYear());
  if (!ejercicio) return NextResponse.json({ error: "ejercicio inválido" }, { status: 400 });

  const diasAguinaldo = sp.get("diasAguinaldo") ? Number(sp.get("diasAguinaldo")) : DIAS_AGUINALDO_MINIMO;
  if (!Number.isFinite(diasAguinaldo) || diasAguinaldo < DIAS_AGUINALDO_MINIMO) {
    return NextResponse.json(
      { error: `Los días de aguinaldo deben ser al menos ${DIAS_AGUINALDO_MINIMO} (Art. 87 LFT).` },
      { status: 400 }
    );
  }

  const fechaPago = parseFechaPago(sp.get("fechaPago"));
  if (fechaPago === null) return NextResponse.json({ error: "fechaPago inválida" }, { status: 400 });

  const preview = await previewAguinaldo({ companyId, ejercicio, diasAguinaldo, fechaPago });
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

  const fechaPago = parseFechaPago(body.fechaPago);
  if (fechaPago === null) return NextResponse.json({ error: "fechaPago inválida" }, { status: 400 });

  const items = Array.isArray(body.items)
    ? (body.items as { employeeId?: unknown; monto?: unknown }[]).map((i) => ({
        employeeId: String(i.employeeId ?? ""),
        monto: i.monto != null ? Number(i.monto) : undefined,
      }))
    : undefined;
  if (items?.some((i) => !i.employeeId)) {
    return NextResponse.json({ error: "items inválidos: falta employeeId" }, { status: 400 });
  }

  const result = await crearCorridaAguinaldo({
    companyId,
    ejercicio,
    diasAguinaldo: body.diasAguinaldo != null ? Number(body.diasAguinaldo) : undefined,
    fechaPago,
    items,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
