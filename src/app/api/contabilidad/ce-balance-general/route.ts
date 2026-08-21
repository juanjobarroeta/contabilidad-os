import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { balanza } from "@/lib/contabilidad/posting";
import {
  aLadoEnSigno,
  construirBalance,
  type SaldoCuenta,
} from "@/lib/contabilidad/balance-ce";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/contabilidad/ce-balance-general?companyId=…&anio=2026&mes=6
//
// El balance general con la balanza PRESENTADA como columna vertebral y lo
// derivado de los CFDIs al lado. El gemelo de ce-estado-resultados, con una
// diferencia que no es de forma: el balance es una FOTO al cierre del mes, no
// el flujo del período.
//
// Por eso NO hay `?ytd=`: un balance siempre es acumulado hasta su fecha; un
// «balance del mes» no existe. El mes elegido es la fecha de corte.
//
// Declarado: `saldoFin` de las hojas de CeBalanzaMes de ESE mes (ya trae el
// acumulado; no se suman meses). Derivado: `balanza()`, que arrastra los
// saldos de todos los períodos previos —apertura incluida— para que la foto
// tenga de dónde partir.
//
// Un período que aún no se presenta devuelve `presentado: false` y sólo la
// columna derivada.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const anio = Number(searchParams.get("anio"));
  const mes = Number(searchParams.get("mes"));
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return NextResponse.json({ error: "anio y mes requeridos" }, { status: 400 });
  }

  const [declaradoRaw, derivadoRows, nombres] = await Promise.all([
    // Sólo el mes de corte: saldoFin YA es el acumulado a esa fecha.
    prisma.ceBalanzaMes.findMany({
      where: { companyId, anio, mes, esPadre: false },
      select: { numCta: true, saldoFin: true },
    }),
    balanza(companyId, anio, mes),
    prisma.chartAccount.findMany({
      where: { companyId },
      select: { cuentaSAT: true, nombre: true },
    }),
  ]);

  const nombreDe = new Map(nombres.map((n) => [n.cuentaSAT, n.nombre]));

  const declarado: SaldoCuenta[] = declaradoRaw.map((r) => ({
    numCta: r.numCta,
    nombre: nombreDe.get(r.numCta) ?? null,
    // Ya viene con el lado en el signo — es la convención de la balanza CE.
    saldo: r.saldoFin,
  }));

  // `balanza()` entrega saldoFinal en signo NATURAL; se traduce a la misma
  // convención que el declarado para que los dos lados sean comparables.
  //
  // SIN filtro por nivel, a diferencia de balanceGeneralDesdeBalanza. Ahí el
  // `nivel >= 3` es inofensivo porque el catálogo semilla del SAT postea en
  // nivel 3; en el plan PROPIO no: de las 1,314 cuentas de MARGOM que empatan
  // con la balanza CE, 1,301 son NIVEL 2. Ese filtro habría vaciado la columna
  // derivada entera y en silencio — el balance se vería «sin datos derivados»
  // en vez de «filtro equivocado». No hace falta: `balanza()` agrupa por
  // cuenta y NO acumula las hijas en el padre, así que cada peso está posteado
  // en exactamente una cuenta y sumar todas no duplica nada. Los padres
  // estructurales sin movimiento llegan en cero y el armado los descarta.
  const derivado: SaldoCuenta[] = derivadoRows.map((r) => ({
    numCta: r.subcuenta ?? r.cuentaSAT,
    nombre: r.nombre,
    saldo: aLadoEnSigno(r.saldoFinal, r.tipo),
  }));

  const presentado = declaradoRaw.length > 0;

  return NextResponse.json({
    anio,
    mes,
    ...construirBalance(declarado, derivado, { presentado }),
  });
});
