/**
 * Cuadre de dinero para la migración Float → Decimal (docs/FLOAT-DECIMAL.md).
 *
 * Toma una foto de sumas de dinero por empresa sobre los modelos ancla y la
 * compara contra una foto previa. Se corre ANTES de aplicar la migración de
 * una ola y DESPUÉS, contra la misma base: los totales deben cuadrar dentro
 * de la tolerancia (el ruido de agregación float8 es < centavos; una
 * divergencia mayor significa que la conversión de columnas tocó valores).
 *
 * Uso (apuntar DATABASE_URL a la base objetivo):
 *   DATABASE_URL=<url> ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/decimal-cuadre.ts --out antes.json
 *   ... aplicar migración ...
 *   DATABASE_URL=<url> ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/decimal-cuadre.ts --compare antes.json [--tolerancia 0.01]
 *
 * Sólo lectura — no toca nada. Exit 1 si hay divergencias sobre la tolerancia.
 */
import { readFileSync, writeFileSync } from "fs";
import { prisma } from "../src/lib/prisma";

type Snapshot = Record<string, Record<string, number>>;

const r2 = (n: number | null | undefined) => Math.round(((n ?? 0) as number) * 100) / 100;

async function tomarFoto(): Promise<Snapshot> {
  const foto: Snapshot = {};
  const poner = (grupo: string, clave: string, valor: number | null | undefined) => {
    (foto[grupo] ??= {})[clave] = r2(valor);
  };

  const invoices = await prisma.invoice.groupBy({
    by: ["companyId", "tipo"],
    _count: true,
    _sum: { total: true, subtotal: true, totalImpuestos: true },
  });
  for (const f of invoices) {
    const g = `invoice:${f.companyId}:${f.tipo}`;
    poner(g, "count", f._count);
    poner(g, "total", Number(f._sum.total));
    poner(g, "subtotal", Number(f._sum.subtotal));
    poner(g, "totalImpuestos", Number(f._sum.totalImpuestos));
  }

  const bancos = await prisma.bankTransaction.groupBy({
    by: ["companyId"],
    _count: true,
    _sum: { monto: true },
  });
  for (const f of bancos) {
    poner(`bankTx:${f.companyId}`, "count", f._count);
    poner(`bankTx:${f.companyId}`, "monto", Number(f._sum.monto));
  }

  const nomina = await prisma.payrollRun.groupBy({
    by: ["companyId"],
    _count: true,
    _sum: { totalPercepciones: true, totalDeducciones: true, totalNeto: true },
  });
  for (const f of nomina) {
    const g = `payrollRun:${f.companyId}`;
    poner(g, "count", f._count);
    poner(g, "totalPercepciones", f._sum.totalPercepciones);
    poner(g, "totalDeducciones", f._sum.totalDeducciones);
    poner(g, "totalNeto", f._sum.totalNeto);
  }

  const items = await prisma.payrollItem.aggregate({
    _count: true,
    _sum: { sueldoBase: true, isrRetenido: true, imssObrero: true },
  });
  poner("payrollItem:global", "count", items._count);
  poner("payrollItem:global", "sueldoBase", items._sum.sueldoBase);
  poner("payrollItem:global", "isrRetenido", items._sum.isrRetenido);
  poner("payrollItem:global", "imssObrero", items._sum.imssObrero);

  const decl = await prisma.taxDeclaration.groupBy({
    by: ["companyId"],
    _count: true,
    _sum: { ivaPagar: true, isrPagar: true },
  });
  for (const f of decl) {
    const g = `taxDeclaration:${f.companyId}`;
    poner(g, "count", f._count);
    poner(g, "ivaPagar", f._sum.ivaPagar);
    poner(g, "isrPagar", f._sum.isrPagar);
  }

  const asientos = await prisma.accountingEntry.aggregate({
    _count: true,
    _sum: { monto: true },
  });
  poner("accountingEntry:global", "count", asientos._count);
  poner("accountingEntry:global", "monto", asientos._sum.monto);

  const balanza = await prisma.ceBalanzaMes.aggregate({
    _count: true,
    _sum: { debe: true, haber: true },
  });
  poner("ceBalanzaMes:global", "count", balanza._count);
  poner("ceBalanzaMes:global", "debe", balanza._sum.debe);
  poner("ceBalanzaMes:global", "haber", balanza._sum.haber);

  return foto;
}

function comparar(antes: Snapshot, ahora: Snapshot, tolerancia: number): string[] {
  const diffs: string[] = [];
  const grupos = new Set([...Object.keys(antes), ...Object.keys(ahora)]);
  for (const g of grupos) {
    const a = antes[g];
    const b = ahora[g];
    if (!a || !b) {
      diffs.push(`${g}: presente sólo en ${a ? "ANTES" : "AHORA"}`);
      continue;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = a[k] ?? 0;
      const vb = b[k] ?? 0;
      const delta = Math.abs(va - vb);
      const limite = k === "count" ? 0 : tolerancia;
      if (delta > limite) diffs.push(`${g}.${k}: antes=${va} ahora=${vb} (Δ ${delta.toFixed(6)})`);
    }
  }
  return diffs;
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const cmp = args.includes("--compare") ? args[args.indexOf("--compare") + 1] : null;
  const tolerancia = args.includes("--tolerancia")
    ? parseFloat(args[args.indexOf("--tolerancia") + 1])
    : 0.01;
  if (!out && !cmp) {
    console.error("Uso: decimal-cuadre.ts --out <foto.json> | --compare <foto.json> [--tolerancia 0.01]");
    process.exit(2);
  }

  const foto = await tomarFoto();

  if (out) {
    writeFileSync(out, JSON.stringify(foto, null, 2));
    console.log(`Foto guardada en ${out} (${Object.keys(foto).length} grupos).`);
    return;
  }

  const antes = JSON.parse(readFileSync(cmp!, "utf8")) as Snapshot;
  const diffs = comparar(antes, foto, tolerancia);
  if (diffs.length === 0) {
    console.log(`Cuadra. ${Object.keys(foto).length} grupos dentro de ±${tolerancia}.`);
    return;
  }
  console.error(`NO CUADRA — ${diffs.length} divergencias (tolerancia ±${tolerancia}):`);
  for (const d of diffs) console.error(`  ${d}`);
  process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
