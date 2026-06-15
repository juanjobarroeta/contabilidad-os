import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// POST /api/impuestos/coeficiente  { companyId, year, coeficiente }
// Fija el coeficiente de utilidad de la empresa para el ejercicio (override que
// usa el motor en los pagos provisionales). Lo usa el botón "usar sugerido".
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { companyId } = body ?? {};
    const year = parseInt(String(body?.year ?? ""));
    const coeficiente = Number(body?.coeficiente);
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    if (!Number.isFinite(coeficiente) || coeficiente < 0 || coeficiente > 5) {
      return NextResponse.json({ error: "coeficiente fuera de rango" }, { status: 400 });
    }
    await requireWriter(companyId, req);

    const redondeado = Math.round(coeficiente * 10000) / 10000;
    await prisma.company.update({
      where: { id: companyId },
      data: { coeficienteUtilidad: redondeado, coeficienteAnio: year },
    });
    return NextResponse.json({ ok: true, coeficiente: redondeado, year });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
