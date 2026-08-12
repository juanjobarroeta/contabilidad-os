import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { calcularCobertura, NOTAS_COBERTURA } from "@/lib/automotriz/cobertura";
import { invariantes } from "@/lib/automotriz/invariantes";
import { senales, type LineaEvaluable } from "@/lib/automotriz/senales";
import { calcularResultados } from "@/lib/automotriz/resultados";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/cobertura?companyId=…&year=2026[&month=7]
//
// La pregunta que el estado de resultados no hace: ¿qué NO está contando?
//
// Devuelve tres cosas que fallan distinto, y por eso van separadas:
//   • cobertura   — pesos facturados que ninguna línea reclama, ya agrupados en
//                   clusters accionables (el orden de trabajo del onboarding).
//   • invariantes — lo aritméticamente imposible. No se discute.
//   • senales     — lo implausible. Sí se discute, y la banda va a la vista.
//
// Ninguna de las tres corrige nada. Si el tablero miente, se arregla el
// derivador; este endpoint sólo se niega a ayudar a esconderlo.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  const monthParam = searchParams.get("month");
  const month = monthParam ? Number(monthParam) : null;
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json({ error: "Mes inválido" }, { status: 400 });
  }

  const desde = month ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const hasta = month ? new Date(year, month, 1) : new Date(year + 1, 0, 1);
  const periodo = month ? `${year}-${String(month).padStart(2, "0")}` : String(year);

  const [cobertura, violaciones, resultados] = await Promise.all([
    calcularCobertura(prisma, companyId, desde, hasta, { maxClusters: 50 }),
    invariantes(prisma, companyId, desde, hasta),
    calcularResultados(prisma, companyId, desde, hasta),
  ]);

  // Las señales se evalúan sobre las líneas del MISMO estado de resultados que
  // ve el distribuidor: si el tablero muestra 98.6%, la señal habla de ese 98.6%
  // y no de un número recalculado que nadie reconocería.
  const evaluables: LineaEvaluable[] = resultados.lineas.map((l) => ({
    clave: l.clave,
    nombre: l.nombre,
    ingreso: l.ingreso,
    costo: l.costo,
    margen: l.margen,
    documentos: l.ordenes ?? l.unidades ?? 0,
    ingresoSinCosto: l.ingresoSinCosto ?? 0,
  }));

  return NextResponse.json({
    year,
    periodo,
    cobertura,
    invariantes: violaciones,
    senales: senales(evaluables),
    notas: NOTAS_COBERTURA,
  });
});
