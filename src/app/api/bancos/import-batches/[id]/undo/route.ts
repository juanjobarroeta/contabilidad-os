/**
 * POST /api/bancos/import-batches/[id]/undo
 *   Body: { companyId }
 *   Sesión web O token de servicio (Bearer, satélites como JCPT). Deshace un
 *   lote de importación: borra los movimientos del lote que siguen sin
 *   conciliar (UNMATCHED o IGNORED sin enlaces) y CONSERVA los ya conciliados
 *   con CFDI — deshacer nunca destruye trabajo fiscal hecho. Idempotente: un
 *   lote ya deshecho responde { borrados: 0, conservados: 0 }.
 */

import { NextResponse } from "next/server";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { deshacerLoteImportado } from "@/lib/bancos/undo-import";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const companyId = typeof body.companyId === "string" ? body.companyId : "";
  if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const res = await deshacerLoteImportado(id, companyId, user.id);
  return NextResponse.json(res);
}
