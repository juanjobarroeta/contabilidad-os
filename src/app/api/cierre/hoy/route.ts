import { NextResponse } from "next/server";
import { empresasAccesiblesIds, requireUser, withAuthz } from "@/lib/authz";
import { filasHoy } from "@/lib/cierre/hoy";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cierre/hoy
//
// Lo que hay que hacer hoy en todos los RFCs del usuario con cierre guiado:
// filas por paso pendiente (ranqueadas) y un resumen por empresa/periodo.
// Lee lo que el pase diario persistió — no corre motores.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const ids = await empresasAccesiblesIds(user.id);
  const r = await filasHoy(ids);
  return NextResponse.json(r);
});
