// Repara los lotes importados de PDF que quedaron SIN saldo inicial o final.
//
// `leerSaldos` (controles-estado.ts) lee los saldos del texto del estado de
// cuenta de forma determinista; llegó el 8-sep-2026 a las 17:38 UTC, y el
// lote que lo motivó —un BBVA de cheques de 17 páginas— se había importado a
// las 17:13. El lote quedó con `saldoFinal: null` y `cuadro: false` (importado
// con confirmación) aunque el PDF dice «Saldo Final (+) 77,635.71» en la
// primera página. Un parser corregido no repara lo que ya se guardó: eso lo
// hace este pase, releyendo el PDF que el lote conserva como evidencia.
//
// Sólo toca lotes con PDF y algún saldo en null. Rellena lo que falte, nunca
// pisa lo que ya estaba, y recalcula `cuadro` con la MISMA regla del importador
// (saldo inicial + Σ movimientos ≈ saldo final, ±$1.00) cuando por fin están
// los dos saldos. Un PNG (captura de pantalla) no tiene texto: se enseña y se
// deja.
//
// Uso:
//   npx tsx scripts/lotes-saldos-del-texto.ts          → sólo enseña
//   npx tsx scripts/lotes-saldos-del-texto.ts --apply  → escribe
import { prisma } from "../src/lib/prisma";
import { leerPdf } from "../src/lib/bancos/pdf-paginas";
import { leerSaldos } from "../src/lib/bancos/controles-estado";

/** La misma holgura que vision-statement.ts (BALANCE_TOLERANCE). */
const TOLERANCIA = 1.0;
const APPLY = process.argv.includes("--apply");
const f = (n: number | null) => n == null ? "null" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const lotes = await prisma.importBatch.findMany({
    where: { archivoPdf: { not: null }, undoneAt: null, OR: [{ saldoFinal: null }, { saldoInicial: null }] },
    select: {
      id: true, archivoNombre: true, archivoMime: true, archivoPdf: true, saldoInicial: true, saldoFinal: true, cuadro: true,
      company: { select: { razonSocial: true } }, bankAccount: { select: { banco: true, numeroCuenta: true } },
      transactions: { select: { monto: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Lotes con PDF y algún saldo en null: ${lotes.length}\n`);

  let reparados = 0;
  for (const l of lotes) {
    const etiqueta = `${l.company.razonSocial.slice(0, 26)} · ${l.bankAccount.banco} ··${l.bankAccount.numeroCuenta.slice(-4)} · ${l.archivoNombre ?? l.id}`;
    if (l.archivoMime && !/pdf/i.test(l.archivoMime)) {
      console.log(`  — ${etiqueta}: ${l.archivoMime}, sin texto que leer. Se deja.`);
      continue;
    }
    const leido = await leerPdf(Buffer.from(l.archivoPdf!));
    if (!leido) { console.log(`  — ${etiqueta}: el PDF no da texto (¿escaneado?). Se deja.`); continue; }
    const texto = leerSaldos(leido.texto);
    const inicial = l.saldoInicial != null ? Number(l.saldoInicial) : texto.inicial;
    const final = l.saldoFinal != null ? Number(l.saldoFinal) : texto.final;
    if (inicial === (l.saldoInicial == null ? null : Number(l.saldoInicial)) && final === (l.saldoFinal == null ? null : Number(l.saldoFinal))) {
      console.log(`  — ${etiqueta}: el texto tampoco trae lo que falta (inicial=${f(texto.inicial)}, final=${f(texto.final)}). Se deja.`);
      continue;
    }
    // El cuadre, con la regla del importador, ahora que hay con qué.
    let cuadro = l.cuadro;
    let nota = "";
    if (inicial != null && final != null) {
      const suma = r2(l.transactions.reduce((s, t) => s + Number(t.monto), 0));
      const esperado = r2(inicial + suma);
      const dif = r2(esperado - final);
      cuadro = Math.abs(dif) <= TOLERANCIA;
      nota = ` · cuadre: ${f(inicial)} + ${f(suma)} = ${f(esperado)} vs ${f(final)} → ${cuadro ? "CUADRA" : `NO cuadra (dif ${f(dif)})`}`;
    }
    console.log(`  ✓ ${etiqueta}: inicial ${f(l.saldoInicial == null ? null : Number(l.saldoInicial))} → ${f(inicial)} · final ${f(l.saldoFinal == null ? null : Number(l.saldoFinal))} → ${f(final)}${nota}`);
    if (APPLY) {
      await prisma.importBatch.update({ where: { id: l.id }, data: { saldoInicial: inicial, saldoFinal: final, cuadro } });
      reparados++;
    }
  }
  console.log(APPLY ? `\n${reparados} lote(s) reparado(s).` : "\n(sin --apply: no se escribió nada)");
  await prisma.$disconnect();
}
main();
