// ─────────────────────────────────────────────────────────────────────────────
// Reparación de un estado de cuenta ya importado con errores de lectura.
//
// Corrige lo que la extracción del PDF entendió mal, SIN volver a importar (lo
// que perdería las conciliaciones ya hechas sobre los movimientos buenos):
//
//   · SIGNO: renglones leídos del lado equivocado (un depósito como cargo).
//   · RENGLONES DE MÁS: duplicados exactos y líneas sin importe.
//
// No inventa nada: se le pasan los ids exactos a reparar, calculados contra los
// totales que el propio banco declara. Deja lápida de lo que borra
// (BankTransactionTombstone) para que la importación no lo reviva, y NUNCA
// toca un movimiento ya conciliado con un CFDI — ésos se reportan para que un
// humano decida.
//
// Uso:  npx tsx scripts/reparar-estado-cuenta.ts <archivo.json> [--apply]
//   { "invertirSigno": ["txId", …], "eliminar": ["txId", …], "motivo": "…" }
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");
const ARCHIVO = process.argv[2];

interface Plan {
  invertirSigno?: string[];
  eliminar?: string[];
  motivo?: string;
}

async function main() {
  if (!ARCHIVO || ARCHIVO.startsWith("--")) {
    console.error("Uso: npx tsx scripts/reparar-estado-cuenta.ts <plan.json> [--apply]");
    process.exit(1);
  }
  const plan: Plan = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
  const invertir = plan.invertirSigno ?? [];
  const eliminar = plan.eliminar ?? [];

  const txs = await prisma.bankTransaction.findMany({
    where: { id: { in: [...invertir, ...eliminar] } },
    select: {
      id: true, companyId: true, bankAccountId: true, fecha: true, monto: true,
      descripcion: true, referencia: true, status: true, invoiceId: true,
      conciliacionDetalles: { select: { id: true }, take: 1 },
    },
  });
  const porId = new Map(txs.map((t) => [t.id, t]));

  const conciliados = txs.filter((t) => t.invoiceId || t.conciliacionDetalles.length > 0);
  if (conciliados.length > 0) {
    console.log("⚠ Movimientos YA conciliados con un CFDI — no se tocan, decide un humano:");
    for (const t of conciliados) {
      console.log(`   ${t.id} ${t.fecha.toISOString().slice(0, 10)} $${Number(t.monto).toFixed(2)} ${t.descripcion.slice(0, 50)}`);
    }
  }
  const seguro = (id: string) => {
    const t = porId.get(id);
    return t && !t.invoiceId && t.conciliacionDetalles.length === 0 ? t : null;
  };

  console.log(`\n── Invertir signo: ${invertir.length} ──`);
  for (const id of invertir) {
    const t = seguro(id);
    if (!t) { console.log(`   ${id}: omitido (no existe o está conciliado)`); continue; }
    const nuevo = -Number(t.monto);
    console.log(`   ${t.fecha.toISOString().slice(0, 10)} $${Number(t.monto).toFixed(2)} → $${nuevo.toFixed(2)}  ${t.descripcion.slice(0, 46)}${APPLY ? "" : "  [dry-run]"}`);
    if (APPLY) await prisma.bankTransaction.update({ where: { id }, data: { monto: nuevo } });
  }

  console.log(`\n── Eliminar: ${eliminar.length} ──`);
  for (const id of eliminar) {
    const t = seguro(id);
    if (!t) { console.log(`   ${id}: omitido (no existe o está conciliado)`); continue; }
    console.log(`   ${t.fecha.toISOString().slice(0, 10)} $${Number(t.monto).toFixed(2)} ${t.descripcion.slice(0, 50)}${APPLY ? "" : "  [dry-run]"}`);
    if (APPLY) {
      await prisma.$transaction([
        // Lápida: la reimportación del mismo archivo no debe revivirlo.
        prisma.bankTransactionTombstone.create({
          data: {
            companyId: t.companyId,
            bankAccountId: t.bankAccountId,
            txId: t.id,
            fecha: t.fecha,
            monto: t.monto,
            descripcion: t.descripcion,
            referencia: t.referencia,
            motivo: plan.motivo ?? "renglón inexistente en el estado de cuenta",
          },
        }),
        prisma.bankTransaction.delete({ where: { id } }),
      ]);
    }
  }

  console.log(APPLY ? "\nAPLICADO." : "\ndry-run — usa --apply para escribir.");
  await prisma.$disconnect();
}
main();
