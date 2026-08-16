import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";

// GET /api/contabilidad/ce-serie?companyId=…
//
// La serie de balanzas PRESENTADAS al SAT (CeBalanzaMes) — la fuente CE-first:
// lo que el contador declaró, no lo que el motor derivó.
//
//   • sin `cuenta`: el ÍNDICE — cada cuenta (hojas por default) con su nombre
//     del catálogo, el último saldoFin y el rango de períodos presentados.
//     `?padres=1` incluye los mayores (su saldo YA suma a sus hijas: sumar
//     ambos duplica — por eso van separados).
//   • con `cuenta=1301-0004-0000`: la serie mensual completa de esa cuenta
//     (saldoIni/debe/haber/saldoFin por período) para el drill-down.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);

  const cuenta = searchParams.get("cuenta");
  if (cuenta) {
    const serie = await prisma.ceBalanzaMes.findMany({
      where: { companyId, numCta: cuenta },
      select: { anio: true, mes: true, saldoIni: true, debe: true, haber: true, saldoFin: true, esPadre: true },
      orderBy: [{ anio: "asc" }, { mes: "asc" }],
    });
    if (serie.length === 0) {
      return NextResponse.json({ error: `Sin balanzas presentadas para ${cuenta}` }, { status: 404 });
    }
    return NextResponse.json({ cuenta, serie });
  }

  const incluirPadres = searchParams.get("padres") === "1";
  const [filas, nombres] = await Promise.all([
    prisma.ceBalanzaMes.groupBy({
      by: ["numCta", "esPadre"],
      where: { companyId, ...(incluirPadres ? {} : { esPadre: false }) },
      _count: { _all: true },
      _min: { anio: true },
      _max: { anio: true },
    }),
    prisma.chartAccount.findMany({
      where: { companyId },
      select: { cuentaSAT: true, subcuenta: true, nombre: true },
    }),
  ]);
  const nombrePorCodigo = new Map(nombres.map((n) => [n.subcuenta ?? n.cuentaSAT, n.nombre]));

  // El último período presentado (una sola consulta, no una por cuenta).
  const ultimo = await prisma.ceBalanzaMes.findFirst({
    where: { companyId },
    orderBy: [{ anio: "desc" }, { mes: "desc" }],
    select: { anio: true, mes: true },
  });
  const saldos = ultimo
    ? await prisma.ceBalanzaMes.findMany({
        where: { companyId, anio: ultimo.anio, mes: ultimo.mes },
        select: { numCta: true, saldoFin: true },
      })
    : [];
  const saldoPorCuenta = new Map(saldos.map((s) => [s.numCta, s.saldoFin]));

  return NextResponse.json({
    ultimoPeriodo: ultimo,
    cuentas: filas
      .map((f) => ({
        numCta: f.numCta,
        nombre: nombrePorCodigo.get(f.numCta) ?? null,
        esPadre: f.esPadre,
        periodos: f._count._all,
        desde: f._min.anio,
        hasta: f._max.anio,
        saldoFinUltimo: saldoPorCuenta.get(f.numCta) ?? null,
      }))
      .sort((a, b) => a.numCta.localeCompare(b.numCta)),
  });
});
