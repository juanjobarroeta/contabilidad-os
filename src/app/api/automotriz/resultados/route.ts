import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { calcularResultados, NOTAS_RESULTADOS } from "@/lib/automotriz/resultados";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/resultados?companyId=…&year=2026[&month=7][&ytd=1]
//
// Estado de resultados POR LÍNEA DE NEGOCIO — como lee su negocio un
// distribuidor, no como lo declara. El cálculo vive en lib/automotriz/resultados
// para que el panel muestre exactamente la misma utilidad del mes; aquí sólo se
// resuelve el periodo y se arma el detalle desplegable.
//
// El estado de resultados FISCAL (el que cuadra con la contabilidad) vive en el
// hub y sale del ledger — este es el tablero de operación.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

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
  // Periodo: el ejercicio completo, un mes (month=1..12) o al día de hoy
  // (ytd=1) — las tres lecturas que pide un director de agencia.
  const monthParam = searchParams.get("month");
  const month = monthParam ? Number(monthParam) : null;
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json({ error: "Mes inválido" }, { status: 400 });
  }
  const ytd = searchParams.get("ytd") === "1";
  const hoy = new Date();
  const desde = month ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const hasta = month
    ? new Date(year, month, 1)
    : ytd && year === hoy.getFullYear()
      ? new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1)
      : new Date(year + 1, 0, 1);
  const periodo = month ? `${year}-${String(month).padStart(2, "0")}` : ytd ? `${year} al día` : String(year);

  const res = await calcularResultados(prisma, companyId, desde, hasta);
  const { unidades, servicios } = res.fuentes;

  // Mes a mes de lo que sí es comparable (unidades y taller).
  const meses = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1, nuevas: 0, seminuevas: 0, manoObra: 0, refacciones: 0,
  }));
  for (const u of unidades) {
    if (!u.fechaVenta) continue;
    const m = meses[new Date(u.fechaVenta).getMonth()];
    if (u.tipo === "NUEVO") m.nuevas = r2(m.nuevas + (u.precioVenta ?? 0));
    else m.seminuevas = r2(m.seminuevas + (u.precioVenta ?? 0));
  }
  for (const s of servicios) {
    const m = meses[new Date(s.fecha).getMonth()];
    m.manoObra = r2(m.manoObra + s.manoObra);
    m.refacciones = r2(m.refacciones + s.refacciones);
  }

  return NextResponse.json({
    year,
    periodo,
    lineas: res.lineas,
    totales: res.totales,
    gastos: res.gastos,
    estructura: res.estructura,
    nomina: res.nomina,
    absorcion: res.absorcion,
    porMes: meses,
    // Detalle para desplegar sin pedir otra pantalla: cada venta del periodo
    // con su utilidad, y la nómina agrupada por persona.
    detalle: {
      ventas: unidades
        .map((u) => {
          const costos = u.costos.reduce((s, c) => s + c.monto, 0);
          const sinCosto = u.costoCompra <= 0;
          return {
            id: u.id,
            vin: u.vin,
            unidad: `${u.marca} ${u.modelo} ${u.anio}`,
            tipo: u.tipo,
            fecha: u.fechaVenta,
            // El Customer manda cuando existe; si la venta fue a público en
            // general, el nombre del receptor del CFDI es lo que hay.
            cliente: u.cliente?.razonSocial ?? u.ventaInvoice?.contraparteNombre ?? null,
            clienteId: u.cliente?.id ?? null,
            precioVenta: u.precioVenta ?? 0,
            costo: sinCosto ? null : r2(u.costoCompra + costos + u.comisionMonto),
            utilidad: sinCosto ? null : r2((u.precioVenta ?? 0) - u.costoCompra - costos - u.comisionMonto),
          };
        })
        .sort((a, b) => (b.fecha && a.fecha ? +new Date(b.fecha) - +new Date(a.fecha) : 0)),
      nomina: await nominaPorEmpleado(companyId, desde, hasta),
    },
    notas: NOTAS_RESULTADOS,
  });
});

/** Nómina por persona: el desglose que se pide cuando el total no cuadra. */
async function nominaPorEmpleado(companyId: string, desde: Date, hasta: Date) {
  const filas = await prisma.$queryRaw<
    Array<{
      rfc: string | null; empleado: string | null; puesto: string | null; sucursal: string | null;
      linea: string; percepciones: number; cuotas: number; recibos: number; sbc: number | null;
    }>
  >`
    SELECT n."rfcEmpleado" AS rfc,
           (array_agg(n."empleado" ORDER BY n."fecha" DESC))[1]    AS empleado,
           (array_agg(n."puesto"   ORDER BY n."fecha" DESC))[1]    AS puesto,
           (array_agg(n."sucursal" ORDER BY n."fecha" DESC))[1]    AS sucursal,
           (array_agg(n."linea"::text ORDER BY n."fecha" DESC))[1] AS linea,
           (array_agg(n."sbcDiario" ORDER BY n."fecha" DESC))[1]    AS sbc,
           COALESCE(SUM(n."percepciones"), 0)::float8      AS percepciones,
           COALESCE(SUM(n."cuotasPatronales"), 0)::float8  AS cuotas,
           COUNT(*)::int                                    AS recibos
    FROM "NominaCosto" n
    WHERE n."companyId" = ${companyId}
      AND n."fecha" >= ${desde} AND n."fecha" < ${hasta}
    GROUP BY n."rfcEmpleado"
    ORDER BY 6 DESC
  `;
  return filas.map((e) => ({
    rfc: e.rfc,
    empleado: e.empleado ?? e.rfc ?? "(sin nombre en el recibo)",
    puesto: e.puesto,
    sucursal: e.sucursal,
    linea: e.linea,
    // SBC del recibo más reciente del periodo: el salario REGISTRADO con
    // autoridad de CFDI. Los campos de salario del Employee son captura vieja
    // (hay $59 y $79 diarios imposibles como SBC); el recibo es el dato.
    sbcDiario: e.sbc,
    percepciones: Math.round(e.percepciones * 100) / 100,
    cuotasPatronales: Math.round(e.cuotas * 100) / 100,
    monto: Math.round((e.percepciones + e.cuotas) * 100) / 100,
    recibos: e.recibos,
  }));
}
