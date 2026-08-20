import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import {
  construirEstadoResultados,
  type MovimientoCuenta,
} from "@/lib/contabilidad/estado-resultados-ce";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/contabilidad/ce-estado-resultados?companyId=…&anio=2026&mes=6[&ytd=1]
//
// El estado de resultados con la balanza PRESENTADA como columna vertebral y
// lo derivado de los CFDIs al lado, como evidencia. Ver estado-resultados-ce.ts
// para el porqué de esa jerarquía.
//
// `?ytd=1` acumula desde enero del ejercicio; sin él, sólo el mes.
// Un período que aún no se presenta devuelve `presentado: false` y sólo la
// columna derivada — que es justamente el valor: dónde va a cerrar el mes.
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
  const ytd = searchParams.get("ytd") === "1";
  const desdeMes = ytd ? 1 : mes;

  const [declaradoRaw, derivadoRaw, nombres] = await Promise.all([
    prisma.ceBalanzaMes.findMany({
      where: { companyId, anio, mes: { gte: desdeMes, lte: mes }, esPadre: false },
      select: { numCta: true, debe: true, haber: true },
    }),
    prisma.accountingEntry.findMany({
      // APERTURA y CIERRE quedan FUERA: no son operaciones del período. La
      // apertura de MARGOM (2026-07) carga $599.6M en cuentas de resultado —el
      // acumulado del ejercicio anterior traído al nuevo— y contarla haría de
      // julio un mes seis veces más grande que cualquier otro. El cierre es lo
      // simétrico: existe para dejar las cuentas de resultado en cero.
      where: {
        companyId,
        year: anio,
        month: { gte: desdeMes, lte: mes },
        fuente: { notIn: ["APERTURA", "CIERRE"] },
      },
      select: { monto: true, tipo: true, chartAccount: { select: { cuentaSAT: true, nombre: true } } },
    }),
    prisma.chartAccount.findMany({
      where: { companyId },
      select: { cuentaSAT: true, nombre: true },
    }),
  ]);

  const nombreDe = new Map(nombres.map((n) => [n.cuentaSAT, n.nombre]));

  const declarado: MovimientoCuenta[] = declaradoRaw.map((r) => ({
    numCta: r.numCta,
    nombre: nombreDe.get(r.numCta) ?? null,
    monto: r.haber - r.debe,
  }));
  const derivado: MovimientoCuenta[] = derivadoRaw.map((e) => ({
    numCta: e.chartAccount.cuentaSAT,
    nombre: e.chartAccount.nombre,
    monto: e.tipo === "ABONO" ? e.monto : -e.monto,
  }));

  // «Presentado» es del MES pedido: en acumulado basta que ese mes exista para
  // que la columna declarada sea comparable renglón a renglón.
  const presentado = declaradoRaw.length > 0;

  return NextResponse.json({
    anio,
    mes,
    ytd,
    ...construirEstadoResultados(declarado, derivado, { presentado }),
  });
});
