import { NextResponse } from "next/server";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { anticiposPendientes } from "@/lib/bancos/anticipos";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bancos/anticipos?companyId=
//
// Anticipos cobrados o pagados que siguen sin CFDI, del más viejo al más nuevo.
// Es una lista de OBLIGACIONES, no de avisos: etiquetar el movimiento no lo
// saca de aquí — sólo lo saca el comprobante.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  return NextResponse.json(await anticiposPendientes(companyId));
}
