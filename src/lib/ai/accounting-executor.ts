import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { naturalezaPorTipo, saldosCoe } from "@/lib/contabilidad/coe-saldos";

/** Same deterministic arithmetic as the Balanza page; no inferred balances. */
export async function executeAccountingRead(name: string, input: Record<string, unknown>, companyId: string) {
  const year = input.year as number, month = input.month as number;
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return JSON.stringify({ error: "Año y mes válidos son requeridos." });
  }
  const period = await prisma.accountingPeriod.findUnique({ where: { companyId_year_month: { companyId, year, month } }, select: { status: true } });
  if (name === "query_auxiliar_cuenta") {
    const account = await prisma.chartAccount.findFirst({ where: { id: String(input.chart_account_id ?? ""), companyId },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true } });
    if (!account) return JSON.stringify({ error: "Cuenta no encontrada en esta empresa." });
    const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(Number(input.limit), 100)) : 50;
    const rows = await prisma.accountingEntry.findMany({ where: { companyId, chartAccountId: account.id, year, month },
      orderBy: [{ fecha: "asc" }, { id: "asc" }], take: limit + 1,
      select: { id: true, fecha: true, descripcion: true, referencia: true, referenciaTipo: true, monto: true, tipo: true, fuente: true } });
    return JSON.stringify({ source: "LEDGER_LOCAL", account, year, month, periodStatus: period?.status ?? "NO_REGISTRADO",
      entries: rows.slice(0, limit), truncated: rows.length > limit,
      note: "Lista de registros existentes; no certifica cobertura completa ni presentación al SAT. No calcules un saldo desde una lista truncada." });
  }
  const search = typeof input.search === "string" ? input.search.trim().slice(0, 100) : "";
  const codes = Array.isArray(input.cuentas) ? input.cuentas.filter((c): c is string => typeof c === "string").slice(0, 25) : [];
  const filters: Prisma.ChartAccountWhereInput[] = [];
  if (search) filters.push({ OR: [{ nombre: { contains: search, mode: "insensitive" } }, { cuentaSAT: { contains: search } }, { subcuenta: { contains: search } }] });
  if (codes.length) filters.push({ OR: [{ subcuenta: { in: codes } }, { subcuenta: null, cuentaSAT: { in: codes } }] });
  const accounts = await prisma.chartAccount.findMany({ where: { companyId, AND: filters }, orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }], take: 26,
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true, naturaleza: true, nivel: true, padreCodigo: true, codAgrup: true, isActive: true } });
  const selected = accounts.slice(0, 25), ids = selected.map((a) => a.id), numbers = selected.map((a) => a.subcuenta ?? a.cuentaSAT);
  if (!selected.length) return JSON.stringify({ year, month, accounts: [], note: "Sin cuentas coincidentes en el catálogo. Esto no significa saldo cero." });
  const before = { OR: [{ year: { lt: year } }, { year, month: { lt: month } }] };
  const [current, prior, ce, latestPeriod] = await Promise.all([
    prisma.accountingEntry.groupBy({ by: ["chartAccountId", "tipo"], where: { companyId, chartAccountId: { in: ids }, year, month }, _sum: { monto: true }, _count: { _all: true } }),
    prisma.accountingEntry.groupBy({ by: ["chartAccountId", "tipo"], where: { companyId, chartAccountId: { in: ids }, ...before }, _sum: { monto: true }, _count: { _all: true } }),
    prisma.ceBalanzaMes.findMany({ where: { companyId, anio: year, mes: month, numCta: { in: numbers } } }),
    prisma.ceBalanzaMes.findFirst({ where: { companyId, OR: [{ anio: { lt: year } }, { anio: year, mes: { lt: month } }] },
      orderBy: [{ anio: "desc" }, { mes: "desc" }], select: { anio: true, mes: true } }),
  ]);
  const previousCe = latestPeriod ? await prisma.ceBalanzaMes.findMany({ where: { companyId, ...latestPeriod, numCta: { in: numbers } } }) : [];
  const ceRow = (row: (typeof ce)[number] | undefined) => row ? {
    source: "BALANZA_CE_IMPORTADA", year: row.anio, month: row.mes, saldoInicial: Number(row.saldoIni), cargos: Number(row.debe),
    abonos: Number(row.haber), saldoFinal: Number(row.saldoFin), isParent: row.esPadre, importedAt: row.createdAt,
  } : null;
  const amount = (rows: typeof current, id: string, type: "CARGO" | "ABONO") => Number(rows.find((r) => r.chartAccountId === id && r.tipo === type)?._sum.monto ?? 0);
  return JSON.stringify({ year, month, periodStatus: period?.status ?? "NO_REGISTRADO", truncated: accounts.length > 25,
    latestPreviousCePeriod: latestPeriod, accounts: selected.map((account) => {
      const code = account.subcuenta ?? account.cuentaSAT;
      const cargos = amount(current, account.id, "CARGO"), abonos = amount(current, account.id, "ABONO");
      const hasEntries = [...current, ...prior].some((r) => r.chartAccountId === account.id);
      return { ...account, code, importedCe: ceRow(ce.find((r) => r.numCta === code)), previousImportedCe: ceRow(previousCe.find((r) => r.numCta === code)),
        localLedger: hasEntries ? { source: "LEDGER_LOCAL", provisional: period?.status !== "POSTED" && period?.status !== "CLOSED", cargos, abonos,
          ...saldosCoe({ naturaleza: (account.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(account.tipo),
            priorCargos: amount(prior, account.id, "CARGO"), priorAbonos: amount(prior, account.id, "ABONO"), cargos, abonos }) } : null };
    }), note: "Cita fuente y periodo de cada cifra. null significa sin evidencia, no cero. La CE histórica no es saldo actual. El ledger puede estar incompleto, incluso con movimientos. No sumes cuentas padre con sus hijas ni compenses deudores contra acreedores sin soporte. Presentación al SAT y saldo local son hechos distintos." });
}
