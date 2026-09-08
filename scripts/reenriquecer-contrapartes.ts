// ─────────────────────────────────────────────────────────────────────────────
// Re-lee los PDFs YA GUARDADOS de un lote y rellena la contraparte que faltaba.
//
// POR QUÉ. La identidad del pagador (nombre, CLABE, clave de rastreo) viaja en
// las SUBLÍNEAS del estado, y sólo se puede leer del PDF. Los estados
// importados antes de que las sublíneas se capturaran —o cuando el corte por
// páginas no arrancaba y la extracción salía corta— dejaron movimientos sin
// contraparte: en Centro, 0 claves de rastreo y 88 de 141 movimientos sin nadie
// a quien atribuirlos. Sin clave de rastreo tampoco se puede pedir el CEP.
//
// Es QUIRÚRGICO: sólo rellena campos de contraparte que están en null. No crea
// ni borra movimientos, no toca importes, fechas, status ni conciliaciones.
// Vuelve a costar una extracción por lote (el PDF original vive en ImportBatch).
//
// Uso: npx tsx scripts/reenriquecer-contrapartes.ts <companyId> [--apply]
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/lib/prisma";
import { extractStatementFromDocument } from "../src/lib/bancos/vision-statement";
import { parseSpei } from "../src/lib/bancos/spei-descripcion";

const APPLY = process.argv.includes("--apply");
const COMPANY = process.argv[2];

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

/**
 * Empareja el movimiento releído con el que ya está en la base.
 *
 * NO se puede casar por (fecha + importe + descripción): la fecha que elige el
 * modelo cambia entre corridas —el estado trae fecha de operación Y de
 * liquidación— y la descripción también se redacta distinto. Con esa llave, 133
 * de 469 movimientos releídos no encontraban a su gemelo.
 *
 * Se casa por IMPORTE (exacto, al centavo) dentro de la misma cuenta, con la
 * fecha más cercana (±5 días) como desempate y la descripción idéntica como
 * preferencia. Cada fila se consume una sola vez, para que dos movimientos del
 * mismo importe no caigan sobre la misma.
 */
function emparejar<T extends { fecha: Date; monto: number; descripcion: string }>(
  candidatos: T[],
  t: { fecha: Date; monto: number; descripcion: string },
  usados: Set<T>,
): T | null {
  const mismos = candidatos.filter(
    (c) => !usados.has(c) && Math.abs(c.monto - t.monto) < 0.005 &&
      Math.abs(c.fecha.getTime() - t.fecha.getTime()) <= 5 * 86400000,
  );
  if (mismos.length === 0) return null;
  const exacta = mismos.filter((c) => norm(c.descripcion) === norm(t.descripcion));
  const pool = exacta.length > 0 ? exacta : mismos;
  pool.sort((a, b) => Math.abs(a.fecha.getTime() - t.fecha.getTime()) - Math.abs(b.fecha.getTime() - t.fecha.getTime()));
  usados.add(pool[0]);
  return pool[0];
}

async function main() {
  if (!COMPANY || COMPANY.startsWith("--")) {
    console.error("Uso: npx tsx scripts/reenriquecer-contrapartes.ts <companyId> [--apply]");
    process.exit(1);
  }
  const lotes = await prisma.importBatch.findMany({
    where: { companyId: COMPANY, archivoPdf: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, bankAccountId: true, archivoNombre: true, archivoMime: true, archivoPdf: true, createdAt: true },
  });
  console.log(`lotes con PDF guardado: ${lotes.length}`);

  let rellenados = 0, sinPar = 0, yaTenian = 0;
  for (const lote of lotes) {
    if (!lote.archivoPdf || !lote.bankAccountId) continue;
    console.log(`\n── ${lote.archivoNombre} (${lote.createdAt.toISOString().slice(0, 16)})`);
    const mime = (lote.archivoMime ?? "application/pdf") as "application/pdf";
    let extraccion;
    try {
      extraccion = await extractStatementFromDocument(Buffer.from(lote.archivoPdf), mime);
    } catch (e) {
      console.log(`   no se pudo releer: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    console.log(`   ${extraccion.transactions.length} movimientos releídos`);

    const filas = await prisma.bankTransaction.findMany({
      where: { bankAccountId: lote.bankAccountId },
      select: { id: true, fecha: true, monto: true, descripcion: true, contraparteNombre: true, contraparteRfc: true, contraparteClabe: true, claveRastreo: true, contraparteBanco: true },
    });
    const candidatos = filas.map((f) => ({ ...f, monto: Number(f.monto) }));
    const usados = new Set<(typeof candidatos)[number]>();

    for (const t of extraccion.transactions) {
      const fila = emparejar(candidatos, t, usados);
      if (!fila) { sinPar++; continue; }
      const spei = parseSpei(t.descripcion, undefined, t.sublineas);
      const data: Record<string, string> = {};
      if (!fila.contraparteNombre && spei.contraparteNombre) data.contraparteNombre = spei.contraparteNombre;
      if (!fila.contraparteRfc && spei.contraparteRfc) data.contraparteRfc = spei.contraparteRfc;
      if (!fila.contraparteClabe && spei.contraparteClabe) data.contraparteClabe = spei.contraparteClabe;
      if (!fila.claveRastreo && spei.claveRastreo) data.claveRastreo = spei.claveRastreo;
      if (Object.keys(data).length === 0) { yaTenian++; continue; }
      rellenados++;
      if (rellenados <= 8) console.log(`   + ${fila.fecha.toISOString().slice(0,10)} $${Number(fila.monto).toFixed(2)} ${Object.keys(data).join(", ")}`);
      if (APPLY) await prisma.bankTransaction.update({ where: { id: fila.id }, data });
    }
  }
  console.log(`\nrellenados: ${rellenados} · ya tenían todo: ${yaTenian} · sin par en la base: ${sinPar}`);
  console.log(APPLY ? "APLICADO." : "dry-run — usa --apply para escribir.");
  await prisma.$disconnect();
}
main();
