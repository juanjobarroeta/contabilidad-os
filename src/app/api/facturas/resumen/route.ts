import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { PERIODO_TODO, etiquetaPeriodo, rangoPeriodo } from "@/lib/periodos";
import { filtrosListaFacturas } from "@/lib/facturas/filtros-lista";

// GET /api/facturas/resumen?companyId=xxx[&periodo=YYYY-MM|YYYY|todo][&tipo=&q=&customerId=]
//
// Cifras de encabezado de la pantalla de Facturas, agregadas en el servidor
// para que sean exactas sin importar cuántas filas cargue la tabla.
//
// `periodo` acota las cifras a la MISMA ventana que el usuario eligió en el
// selector (un mes, un ejercicio o todo el historial). Sin el parámetro se
// mantiene el comportamiento histórico: año en curso.
//
// LAS TARJETAS SIGUEN AL FILTRO. `tipo`, `q` y `customerId` son los mismos
// parámetros de la lista (lib/facturas/filtros-lista) y acotan las TRES cifras
// de arriba: filtrar la tabla a «Egreso» o buscar un cliente y que las tarjetas
// siguieran sumando el periodo entero era mentir con números grandes. Sin
// filtro se conserva el significado de siempre: sólo INGRESO timbrado (lo que
// emites). Con filtro, las cifras son del conjunto filtrado — el mismo que se
// ve en la tabla y el que baja el Excel.
//
// Los CONTEOS de los chips NO siguen al filtro: son el filtro. «Egreso 41» tiene
// que seguir diciendo 41 mientras se mira Ingreso, o no hay a dónde volver.
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
  const enVentana = ventana ? { fecha: ventana } : {};

  // El filtro de la lista. Si trajo su propia ventana (from/to) manda ésa; si
  // no, la del periodo.
  const filtros = filtrosListaFacturas(searchParams, companyId);
  const whereFiltrado = { ...(filtros.fecha ? {} : enVentana), ...filtros.where };

  // Las tarjetas: sobre el conjunto filtrado. Sin tipo, INGRESO (el significado
  // de siempre). Con «Canceladas», lo cancelado — sin exigir STAMPED, que no
  // habría ninguna; el número dice cuánto se canceló, que es lo que se pregunta
  // quien filtra por ahí.
  const whereTarjetas =
    filtros.tipo === "CANCELLED"
      ? whereFiltrado
      : { ...whereFiltrado, status: "STAMPED" as const, ...(filtros.tipo ? {} : { tipo: "INGRESO" as const }) };
  const whereTimbradas =
    filtros.tipo === "CANCELLED" ? whereFiltrado : { ...whereFiltrado, status: "STAMPED" as const };

  const [timbradas, facturado, ivaPositivo, retenidoNeg, porMes, porTipo, canceladas] = await Promise.all([
    // Comprobantes timbrados en la ventana, acotados al filtro.
    prisma.invoice.count({ where: whereTimbradas }),
    // Total del conjunto filtrado.
    prisma.invoice.aggregate({ where: whereTarjetas, _sum: { total: true } }),
    // `totalImpuestos` es un NETO: positivo = trasladado (IVA), negativo =
    // retenido (ISR/IVA retenidos; en NÓMINA, ISR e IMSS del recibo). Sumarlo
    // entero como «IVA» daba −$101,164 al filtrar Nómina: el IMSS de 156
    // recibos presentado como IVA negativo. El IVA es sólo la parte positiva;
    // lo retenido va aparte, con su nombre.
    prisma.invoice.aggregate({
      where: { ...whereTarjetas, totalImpuestos: { gt: 0 } },
      _sum: { totalImpuestos: true },
    }),
    prisma.invoice.aggregate({
      where: { ...whereTarjetas, totalImpuestos: { lt: 0 } },
      _sum: { totalImpuestos: true },
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
    // Conteos por tipo y de canceladas EN LA VENTANA, sin el filtro de tipo
    // (son los chips). Los chips se calculaban sobre las filas ya cargadas
    // (200 de decenas de miles), así que decían "Canceladas 0" aunque la base
    // tuviera cientos: el conteo real tiene que venir del servidor.
    prisma.invoice.groupBy({
      by: ["tipo"],
      where: { companyId, status: { not: "CANCELLED" }, ...enVentana },
      _count: { _all: true },
    }),
    prisma.invoice.count({
      where: { companyId, status: "CANCELLED", ...enVentana },
    }),
  ]);

  const conteoPorTipo = Object.fromEntries(porTipo.map((t) => [t.tipo, t._count._all]));
  const vivas = porTipo.reduce((s, t) => s + t._count._all, 0);

  return NextResponse.json({
    timbradas,
    totalFacturado: facturado._sum.total ?? 0,
    ivaCobrado: ivaPositivo._sum.totalImpuestos ?? 0,
    // Retenciones del conjunto filtrado, en positivo (ISR/IVA retenidos; en
    // nómina, ISR e IMSS). La pantalla lo enseña en lugar del IVA cuando el
    // filtro es Nómina, donde IVA no existe.
    retenido: Math.abs(Number(retenidoNeg._sum.totalImpuestos ?? 0)),
    // Para que la pantalla diga de qué son las cifras.
    filtrado: filtros.filtrado,
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
