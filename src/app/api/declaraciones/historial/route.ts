import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// GET /api/declaraciones/historial?companyId=xxx&year=2025
// Declaraciones CAPTURADAS de una empresa en un ejercicio (mensuales IVA/ISR +
// anual), con montos, estatus y si tienen acuse PDF descargable. Es la vista de
// "lo que SÍ tenemos" (complemento de la cobertura de faltantes).
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    await requireMembership(companyId);

    const rows = await prisma.taxDeclaration.findMany({
      where: {
        companyId,
        // mensuales "2025-01".."2025-13" y la anual "2025".
        OR: [{ periodo: { startsWith: `${year}-` } }, { periodo: String(year) }],
      },
      select: {
        id: true, tipo: true, periodo: true, status: true, isHistorical: true,
        isrPagar: true, isrIngresos: true, isrSaldoFavor: true,
        ivaPagar: true, ivaSaldoFavor: true,
        lineaCaptura: true, fechaPresentacion: true, acusePdfNombre: true,
      },
      orderBy: [{ periodo: "asc" }, { tipo: "asc" }],
    });

    return NextResponse.json({
      year,
      declaraciones: rows.map((r) => ({
        id: r.id,
        tipo: r.tipo,
        periodo: r.periodo,
        status: r.status,
        isHistorical: r.isHistorical,
        isrPagar: r.isrPagar,
        isrIngresos: r.isrIngresos,
        isrSaldoFavor: r.isrSaldoFavor,
        ivaPagar: r.ivaPagar,
        ivaSaldoFavor: r.ivaSaldoFavor,
        lineaCaptura: r.lineaCaptura,
        fechaPresentacion: r.fechaPresentacion ? r.fechaPresentacion.toISOString().slice(0, 10) : null,
        tieneAcuse: !!r.acusePdfNombre,
      })),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
