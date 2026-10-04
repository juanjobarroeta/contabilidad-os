import { NextResponse } from "next/server";
import { requireUser, getEffectiveCompanyMembership, AuthzError } from "@/lib/authz";
import { saludSincronizacion } from "@/lib/sat-salud";

// GET /api/sat/salud?companyId=  → ¿la sincronización con el SAT está detenida y por qué?
// Lo lee el banner de la app; sin acceso a la empresa, 403.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    if (!(await getEffectiveCompanyMembership(user.id, companyId))) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
    const salud = await saludSincronizacion(companyId);
    return NextResponse.json(salud ?? { detenida: false, motivo: null, desde: null, detalle: "" });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
