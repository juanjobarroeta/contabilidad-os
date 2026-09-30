import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { cancelarReciboNomina } from "@/lib/nomina/cancelar-recibo";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/recibos/cancelar — cancela ante el SAT el CFDI de nómina de
// un PayrollItem y deja al empleado LISTO PARA RETIMBRAR. La regla vive en
// lib/nomina/cancelar-recibo.ts (la comparte la puerta del hospital).
//
// Body: { companyId, payrollItemId, motivo: "01"|"02"|"03"|"04", sustituyeUuid? }
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { companyId, payrollItemId } = body ?? {};
  const motivo = String(body?.motivo ?? "");
  const sustituyeUuid = body?.sustituyeUuid ? String(body.sustituyeUuid).trim() : null;

  if (!companyId || !payrollItemId) {
    return NextResponse.json({ error: "companyId y payrollItemId requeridos" }, { status: 400 });
  }
  // Validación del motivo antes de la membresía, como siempre: el cliente
  // recibe el 400 aunque no tenga permisos.
  if (!["01", "02", "03", "04"].includes(motivo)) {
    return NextResponse.json({ error: "Falta el motivo de cancelación (01, 02, 03 o 04)." }, { status: 400 });
  }
  if (motivo === "01" && !sustituyeUuid) {
    return NextResponse.json(
      { error: "El motivo 01 requiere el UUID del recibo que lo sustituye." },
      { status: 400 }
    );
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const r = await cancelarReciboNomina({
    companyId,
    payrollItemId,
    motivo,
    sustituyeUuid,
    actor: { id: session.user.id },
  });
  return NextResponse.json(r.body, { status: r.status });
}
