import { NextResponse } from "next/server";
import {
  requireUser,
  getEffectiveCompanyMembership,
  AuthzError,
} from "@/lib/authz";
import { ivaTimingInput } from "@/lib/fiscal/iva-pue-cobros-db";
import { savePueReview } from "@/lib/fiscal/iva-pue-review";
import { assertPaginaHospitalEnApi } from "@/lib/hospital/permisos";

// Explicit accountant review. Never edits the stamped CFDI, saved returns,
// bank movements or ledger. Historical effects are surfaced by the calculator.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = ivaTimingInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Confirma tratamiento, motivo y evidencia de cobro válidos." },
      { status: 400 },
    );
  const input = parsed.data;
  const member = await getEffectiveCompanyMembership(user.id, input.companyId);
  if (!member || member.role === "VIEWER")
    return NextResponse.json(
      { error: "Sin permisos para confirmar el tratamiento fiscal." },
      { status: 403 },
    );
  try {
    await assertPaginaHospitalEnApi(input.companyId, user.id, req, [
      "impuestos",
    ]);
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const result = await savePueReview(id, input, user.id);
  return NextResponse.json(result, { status: result.status });
}
