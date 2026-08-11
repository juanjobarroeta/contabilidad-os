import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { PERIODO_TODO, etiquetaPeriodo, rangoPeriodo } from "@/lib/facturas/periodos";

// GET /api/facturas/resumen?companyId=xxx[&periodo=YYYY-MM|YYYY|todo]
//
// Cifras de encabezado de la pantalla de Facturas, agregadas en el servidor
// para que sean exactas sin importar cuántas filas cargue la tabla.
//
// `periodo` acota las cifras a la MISMA ventana que el usuario eligió en el
// selector (un mes, un ejercicio o todo el historial). Sin el parámetro se
// mantiene el comportamiento histórico: año en curso.
//
// Además devuelve `periodos`: el conteo de comprobantes por mes, que alimenta
// el selector — así sólo se ofrecen meses que de verdad tienen algo que ver.
// El rollup se hace en Postgres (to_char) para que escale con el volumen.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const membership = await getEffectiveCompanyMembership(user.id, companyId);
  if (!membership) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Ventana de las cifras. Sin `periodo` (llamadas previas al selector) se usa
  // el año en curso, que es lo que la pantalla mostraba antes.
  const periodoParam = searchParams.get("periodo");
  const anioActual = new Date().getFullYear();
  const periodo = periodoParam ?? String(anioActual);
  const rango = periodo === PERIODO_TODO ? null : rangoPeriodo(periodo) ?? rangoPeriodo(String(anioActual));
  const ventana = rango ? { gte: rango.from, lte: rango.to } : undefined;

  const [timbradas, facturado, porMes, porTipo, canceladas] = await Promise.all([
    // Comprobantes timbrados (emitidos + recibidos) en la ventana.
    prisma.invoice.count({
      where: { companyId, status: "STAMPED", ...(ventana ? { fecha: ventana } : {}) },
    }),
    // Total facturado + IVA trasladado: sólo INGRESO timbrado (lo que emites).
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", ...(ventana ? { fecha: ventana } : {}) },
      _sum: { total: true, totalImpuestos: true },
    }),
    // Meses con comprobantes (TODO el historial — el selector no se acota a sí
    // mismo). `fecha` es timestamp sin zona: to_char da el mes en UTC, el mismo
    // que usan rangoPeriodo y postMonth.
    prisma.$queryRaw<{ periodo: string; total: number }[]>`
      SELECT to_char("fecha", 'YYYY-MM') AS periodo, COUNT(*)::int AS total
      FROM "Invoice"
      WHERE "companyId" = ${companyId}
      GROUP BY 1
      ORDER BY 1 DESC`,
    // Conteos por tipo y de canceladas EN LA VENTANA. Los chips de la pantalla
    // se calculaban sobre las filas ya cargadas (200 de decenas de miles), así
    // que decían "Canceladas 0" aunque la base tuviera cientos: el conteo real
    // tiene que venir del servidor.
    prisma.invoice.groupBy({
      by: ["tipo"],
      where: { companyId, status: { not: "CANCELLED" }, ...(ventana ? { fecha: ventana } : {}) },
      _count: { _all: true },
    }),
    prisma.invoice.count({
      where: { companyId, status: "CANCELLED", ...(ventana ? { fecha: ventana } : {}) },
    }),
  ]);

  const conteoPorTipo = Object.fromEntries(porTipo.map((t) => [t.tipo, t._count._all]));
  const vivas = porTipo.reduce((s, t) => s + t._count._all, 0);

  return NextResponse.json({
    timbradas,
    totalFacturado: facturado._sum.total ?? 0,
    ivaCobrado: facturado._sum.totalImpuestos ?? 0,
    periodo,
    etiquetaPeriodo: etiquetaPeriodo(periodo),
    periodos: porMes.map((r) => ({ periodo: r.periodo, total: Number(r.total) })),
    // Conteos exactos para los chips (no dependen de cuántas filas se cargaron).
    conteos: {
      todas: vivas + canceladas,
      ingreso: conteoPorTipo.INGRESO ?? 0,
      egreso: conteoPorTipo.EGRESO ?? 0,
      nomina: conteoPorTipo.NOMINA ?? 0,
      pago: conteoPorTipo.PAGO ?? 0,
      cancelada: canceladas,
    },
  });
}
