import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// POST /api/impuestos/perdida  { companyId, year, perdida }
// Fija el remanente de pérdidas fiscales de ejercicios anteriores pendiente de
// aplicar (ACTUALIZADO, de la última declaración anual) que el motor amortiza en
// los pagos provisionales de Persona Moral (Art. 14 LISR). `perdida = 0` limpia
// el remanente. `year` es el ejercicio en curso (el de los provisionales); el
// remanente corresponde al ejercicio anterior, así que se guarda `year - 1`.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { companyId } = body ?? {};
    const year = parseInt(String(body?.year ?? ""));
    const perdida = Number(body?.perdida);
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    if (!Number.isFinite(perdida) || perdida < 0) {
      return NextResponse.json({ error: "perdida fuera de rango" }, { status: 400 });
    }
    await requireWriter(companyId, req);

    const redondeado = Math.round(perdida * 100) / 100;
    await prisma.company.update({
      where: { id: companyId },
      data: {
        perdidaFiscalPendiente: redondeado > 0 ? redondeado : null,
        perdidaFiscalAnio: redondeado > 0 ? year - 1 : null,
      },
    });
    return NextResponse.json({ ok: true, perdida: redondeado, year });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
