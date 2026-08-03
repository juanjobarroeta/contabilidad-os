/**
 * Lotes de importación de estados de cuenta — para "deshacer una importación".
 *
 * GET /api/bancos/import-batches?companyId=xxx
 *   Sesión web O token de servicio (Bearer, satélites como JCPT). Lista los
 *   últimos lotes NO deshechos de la empresa (todas sus cuentas), cada uno con
 *   cuántos movimientos siguen borrables y cuántos ya se conciliaron.
 */

import { NextResponse } from "next/server";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { listarLotesImportados } from "@/lib/bancos/undo-import";

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json([], { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json([], { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json([], { status: 403 });

  return NextResponse.json(await listarLotesImportados(companyId));
}
