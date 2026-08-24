import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/imss?companyId=…[&anio=YYYY]
//
// La POSICIÓN DE IMSS del año: lo que se le retuvo al trabajador (obrero, sale
// del CFDI) y lo que le cuesta al patrón (patronal, se CALCULA — nunca viaja en
// el recibo; lo puebla scripts/backfill-imss-patronal.ts en PayrollItem), mes a
// mes, contra lo DECLARADO en la Contabilidad Electrónica.
//
// El corte que cuadra es el LADO IMSS completo del patrón: CUOTAS AL IMSS
// (6X-0014) + SAR (6X-0012) juntos, porque el contador reparte el CEAV entre las
// dos. 2407-0001 «RETENCION IMSS» es una cuenta CLEARING por donde pasa toda la
// liquidación (SUA), no la cuota obrera pura — se muestra sólo como contexto.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  // Año: el pedido, o el más reciente con recibos.
  let anio = Number(searchParams.get("anio"));
  if (!anio) {
    const ult = await prisma.$queryRaw<{ y: number }[]>`
      SELECT MAX(EXTRACT(YEAR FROM r."fechaPago"))::int y
      FROM "PayrollRun" r WHERE r."companyId" = ${companyId}`;
    anio = ult[0]?.y ?? new Date().getUTCFullYear();
  }

  // Derivado: obrero + patronal + infonavit por mes, de los recibos del año.
  const meses = await prisma.$queryRaw<any[]>`
    SELECT EXTRACT(MONTH FROM r."fechaPago")::int mes,
      COUNT(*)::int recibos,
      SUM(pi."imssObrero")::float8 obrero,
      SUM(pi."imssPatronal")::float8 patronal,
      SUM(pi."infonavit")::float8 infonavit
    FROM "PayrollItem" pi JOIN "PayrollRun" r ON r.id = pi."payrollRunId"
    WHERE r."companyId" = ${companyId}
      AND EXTRACT(YEAR FROM r."fechaPago") = ${anio}
    GROUP BY 1 ORDER BY 1`;

  // Declarado en CE (leaf): lado IMSS patronal (6X-0014 + 6X-0012), INFONAVIT
  // patronal (6X-0013) y el clearing 2407-0001 para contexto.
  const ce = await prisma.$queryRaw<any[]>`
    SELECT
      COALESCE(SUM("debe")  FILTER (WHERE "numCta" LIKE '6%' AND "numCta" LIKE '%0014%'), 0)::float8 cuotas_imss,
      COALESCE(SUM("debe")  FILTER (WHERE "numCta" LIKE '6%' AND "numCta" LIKE '%0012%'), 0)::float8 sar,
      COALESCE(SUM("debe")  FILTER (WHERE "numCta" LIKE '6%' AND "numCta" LIKE '%0013%'), 0)::float8 infonavit,
      COALESCE(SUM("haber") FILTER (WHERE "numCta" = '2407-0001-0000'), 0)::float8 clearing_ret_imss
    FROM "CeBalanzaMes"
    WHERE "companyId" = ${companyId} AND anio = ${anio} AND "esPadre" = false`;
  const c = ce[0] ?? {};

  const num = (v: any) => Number(v ?? 0);
  const mesesOut = meses.map((m) => ({
    mes: m.mes,
    recibos: num(m.recibos),
    obrero: num(m.obrero),
    patronal: num(m.patronal),
    infonavit: num(m.infonavit),
    total: num(m.obrero) + num(m.patronal) + num(m.infonavit),
  }));
  const tot = mesesOut.reduce(
    (a, m) => ({
      recibos: a.recibos + m.recibos, obrero: a.obrero + m.obrero,
      patronal: a.patronal + m.patronal, infonavit: a.infonavit + m.infonavit,
      total: a.total + m.total,
    }),
    { recibos: 0, obrero: 0, patronal: 0, infonavit: 0, total: 0 },
  );

  const ladoImssDeclarado = num(c.cuotas_imss) + num(c.sar);
  const patronalSinPoblar = tot.patronal === 0 && tot.recibos > 0; // falta correr el backfill

  return NextResponse.json({
    anio,
    meses: mesesOut,
    totales: tot,
    declarado: {
      cuotasImss: num(c.cuotas_imss),
      sar: num(c.sar),
      infonavit: num(c.infonavit),
      ladoImssPatronal: ladoImssDeclarado,
      clearingRetencionImss: num(c.clearing_ret_imss),
    },
    reconciliacion: {
      patronalCalculado: tot.patronal,
      ladoImssDeclarado,
      ratio: ladoImssDeclarado > 0 ? tot.patronal / ladoImssDeclarado : null,
      infonavitCalculado: tot.infonavit,
      infonavitDeclarado: num(c.infonavit),
      patronalSinPoblar, // true = correr scripts/backfill-imss-patronal.ts
    },
  });
});
