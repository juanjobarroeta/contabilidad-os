/**
 * GET /api/salameria/declaraciones?companyId=…[&year=2025]
 *
 * Las declaraciones CAPTURADAS de la empresa: mensuales (IVA/ISR) y anuales,
 * con su importe, su línea de captura y si tenemos el acuse en PDF. Es «lo que
 * sí tenemos» — el histórico de ejercicios anteriores que se guardó al dar de
 * alta a la empresa, no un cálculo.
 *
 * POR QUÉ VIVE AQUÍ Y NO SE LLAMA /api/declaraciones/historial: esa ruta
 * resuelve al usuario por la COOKIE de sesión (`requireMembership(companyId)`
 * sin `req`), así que un satélite con bearer token recibe 401. En vez de
 * cambiarle la firma a una superficie que usa toda la app web, el módulo la
 * envuelve en su propio espacio —igual que hospital y automotriz hacen con
 * contactos— y añade su gate de módulo.
 *
 * Sin `year`, devuelve TODOS los ejercicios con algo capturado: la pregunta
 * real de un histórico es «qué años tengo», no «qué hay en 2025».
 * Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const num = (v: unknown) => (v == null ? null : Number(v));

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const yearParam = searchParams.get("year");
  const year = yearParam ? Number(yearParam) : null;
  if (yearParam && (!Number.isInteger(year) || year! < 2000 || year! > 2100)) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }

  const rows = await prisma.taxDeclaration.findMany({
    where: {
      companyId,
      // `periodo` es "2025-03" / "2025" — el prefijo del año basta y evita
      // depender de que exista una columna `year` en la tabla.
      ...(year ? { periodo: { startsWith: String(year) } } : {}),
    },
    select: {
      id: true,
      tipo: true,
      periodo: true,
      status: true,
      isHistorical: true,
      isrPagar: true,
      isrIngresos: true,
      isrSaldoFavor: true,
      ivaPagar: true,
      ivaSaldoFavor: true,
      lineaCaptura: true,
      fechaPresentacion: true,
      acusePdfNombre: true,
    },
    orderBy: [{ periodo: "desc" }, { tipo: "asc" }],
  });

  const declaraciones = rows.map((r) => ({
    id: r.id,
    tipo: r.tipo,
    periodo: r.periodo,
    ejercicio: Number(String(r.periodo).slice(0, 4)),
    status: r.status,
    // `isHistorical` marca lo que se capturó al dar de alta la empresa: no lo
    // presentamos nosotros, lo heredamos. Se distingue en la UI porque su
    // acuse es la única evidencia que hay.
    historica: r.isHistorical,
    isrPagar: num(r.isrPagar),
    isrIngresos: num(r.isrIngresos),
    isrSaldoFavor: num(r.isrSaldoFavor),
    ivaPagar: num(r.ivaPagar),
    ivaSaldoFavor: num(r.ivaSaldoFavor),
    lineaCaptura: r.lineaCaptura,
    fechaPresentacion: r.fechaPresentacion
      ? r.fechaPresentacion.toISOString().slice(0, 10)
      : null,
    tieneAcuse: !!r.acusePdfNombre,
  }));

  // Resumen por ejercicio: es como se lee un histórico —cuánto se pagó cada
  // año y cuántos períodos hay— antes de entrar al detalle de un mes.
  const porEjercicio = new Map<
    number,
    { ejercicio: number; declaraciones: number; conAcuse: number; isr: number; iva: number }
  >();
  for (const d of declaraciones) {
    const e =
      porEjercicio.get(d.ejercicio) ??
      { ejercicio: d.ejercicio, declaraciones: 0, conAcuse: 0, isr: 0, iva: 0 };
    e.declaraciones++;
    if (d.tieneAcuse) e.conAcuse++;
    e.isr += d.isrPagar ?? 0;
    e.iva += d.ivaPagar ?? 0;
    porEjercicio.set(d.ejercicio, e);
  }

  return NextResponse.json({
    year,
    ejercicios: [...porEjercicio.values()]
      .map((e) => ({
        ...e,
        isr: Math.round(e.isr * 100) / 100,
        iva: Math.round(e.iva * 100) / 100,
      }))
      .sort((a, b) => b.ejercicio - a.ejercicio),
    declaraciones,
  });
});
