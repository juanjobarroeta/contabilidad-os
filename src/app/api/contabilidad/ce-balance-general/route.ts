import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { construirBalance, type SaldoCuenta } from "@/lib/contabilidad/balance-ce";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/contabilidad/ce-balance-general?companyId=…&anio=2026&mes=7
//
// El balance general con la CE COMO ARRANQUE. No es una comparación entre dos
// contabilidades paralelas: la balanza presentada es la verdad al día del
// corte, y lo derivado de los CFDIs sale DE AHÍ hacia adelante.
//
// Por eso el derivado se ancla en la APERTURA y NO cuenta nada anterior a
// ella. Sumar el histórico previo lo duplica: en MARGOM la apertura del
// 2026-07-01 vale $546.6M y el ledger traía $6,514M acumulados desde 2021 sin
// una sola liquidación (nunca ha habido fuente BANCO, así que ninguna CXC se
// cobró ni ninguna CXP se pagó). Sumados daban $7,323M — una posición que no
// existe. Anclado, el balance arranca en lo declarado y sólo se mueve con lo
// que pasó después.
//
// Un balance es una FOTO, no un flujo: por eso no hay `?ytd=`, el mes elegido
// es la fecha de corte, y la apertura no sólo cuenta — es el punto de partida.
//
// Convención de signo: `cargos − abonos` para TODA cuenta. Eso es exactamente
// la convención de la balanza CE (el lado va en el signo: activo positivo,
// pasivo y capital negativos), y no depende de la naturaleza ni del tipo, así
// que no hay signo que deducir mal. La versión anterior convertía desde el
// signo natural y le invertía el lado a las contra-cuentas —«DESCUENTO NUEVOS»
// es tipo INGRESO con naturaleza D— descuadrando el balance por $47,867,455.
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

  // El ancla: el período de la apertura. Es el día uno del libro derivado.
  const apertura = await prisma.accountingEntry.findFirst({
    where: { companyId, fuente: "APERTURA" },
    select: { year: true, month: true },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });

  // Antes del ancla el derivado no significa nada: no tiene de dónde partir.
  // Se dice, en vez de pintar una columna que nadie puede defender.
  const antesDelAncla =
    apertura != null && (anio < apertura.year || (anio === apertura.year && mes < apertura.month));

  const piso = apertura
    ? [{ OR: [{ year: { gt: apertura.year } }, { year: apertura.year, month: { gte: apertura.month } }] }]
    : [];
  const techo = { OR: [{ year: { lt: anio } }, { year: anio, month: { lte: mes } }] };

  const [declaradoRaw, derivadoRaw, cuentas, asientosBanco] = await Promise.all([
    // Sólo el mes de corte: saldoFin YA es el acumulado a esa fecha.
    prisma.ceBalanzaMes.findMany({
      where: { companyId, anio, mes, esPadre: false },
      select: { numCta: true, saldoFin: true },
    }),
    antesDelAncla
      ? Promise.resolve([] as { chartAccountId: string; tipo: string; _sum: { monto: number | null } }[])
      : prisma.accountingEntry.groupBy({
          by: ["chartAccountId", "tipo"],
          where: { companyId, AND: [...piso, techo] },
          _sum: { monto: true },
        }),
    prisma.chartAccount.findMany({
      where: { companyId },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true },
    }),
    // Sin asientos de origen BANCO no hay cobranza ni pagos: las cuentas por
    // cobrar y por pagar sólo pueden crecer, y el saldo derivado deja de ser
    // una posición para volverse un acumulado. La UI tiene que poder decirlo.
    prisma.accountingEntry.count({ where: { companyId, fuente: "BANCO" }, take: 1 }),
  ]);

  const porId = new Map(cuentas.map((c) => [c.id, c]));
  const porCodigo = new Map(cuentas.map((c) => [c.subcuenta ?? c.cuentaSAT, c]));
  const nombreDe = new Map(cuentas.map((c) => [c.cuentaSAT, c.nombre]));

  const declarado: SaldoCuenta[] = declaradoRaw.map((r) => ({
    numCta: r.numCta,
    nombre: nombreDe.get(r.numCta) ?? null,
    // Ya viene con el lado en el signo — es la convención de la balanza CE.
    saldo: Number(r.saldoFin),
    tipo: porCodigo.get(r.numCta)?.tipo ?? null,
  }));

  // cargos − abonos por cuenta: la misma convención, sin conversión de por medio.
  const acum = new Map<string, { nombre: string; tipo: string | null; saldo: number }>();
  for (const g of derivadoRaw) {
    const cta = porId.get(g.chartAccountId);
    if (!cta) continue;
    const codigo = cta.subcuenta ?? cta.cuentaSAT;
    const prev = acum.get(codigo) ?? { nombre: cta.nombre, tipo: cta.tipo, saldo: 0 };
    prev.saldo += (g.tipo === "CARGO" ? 1 : -1) * Number(g._sum.monto ?? 0);
    acum.set(codigo, prev);
  }
  const derivado: SaldoCuenta[] = [...acum].map(([numCta, v]) => ({
    numCta,
    nombre: v.nombre,
    saldo: v.saldo,
    tipo: v.tipo,
  }));

  return NextResponse.json({
    anio,
    mes,
    /** El período donde arranca el libro derivado. Null = sin apertura. */
    ancla: apertura ? { anio: apertura.year, mes: apertura.month } : null,
    /** El corte pedido es anterior al ancla: sólo hay columna declarada. */
    antesDelAncla,
    /** No hay asientos de banco: nada liquida las CXC ni las CXP. */
    sinBanco: asientosBanco === 0,
    ...construirBalance(declarado, derivado, { presentado: declaradoRaw.length > 0 }),
  });
});
