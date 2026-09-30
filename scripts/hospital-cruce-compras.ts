/**
 * Cruce de compras de farmacia: lotes sin CFDI, CFDIs sin recepción y
 * devoluciones al proveedor sin nota de crédito (lib/hospital/cruce-compras).
 * SOLO LECTURA.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/hospital-cruce-compras.ts --company <RFC> --ejercicio 2026 --mes 8 [--meses 1]
 */
import { prisma } from "../src/lib/prisma";
import { cruceCompras } from "../src/lib/hospital/cruce-compras";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dia = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  const meses = Math.max(1, Number(arg("meses") ?? 1));
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/hospital-cruce-compras.ts --company <RFC> --ejercicio <AAAA> --mes <M> [--meses N]");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month - 1 + meses, 1));
  const c = await cruceCompras(prisma, company.id, desde, hasta);

  console.log(`${company.razonSocial} (${rfc}) — cruce de compras de farmacia ${dia(desde)} a ${dia(new Date(hasta.getTime() - 1))}`);
  console.log(`\n── Lotes recibidos SIN CFDI: ${c.lotesSinCfdi.length} por ${fmt(c.totales.lotesSinCfdi)}`);
  for (const l of c.lotesSinCfdi) console.log(`   ${fmt(l.monto).padStart(12)}  ${dia(l.recibidoAt)} ${l.insumo.slice(0, 40).padEnd(40)} lote ${l.lote} · ${l.cantidad} pzas · ${l.proveedor ?? "sin proveedor"}`);
  console.log(`\n── CFDIs de insumos SIN recepción en farmacia: ${c.cfdisSinRecepcion.length} por ${fmt(c.totales.cfdisSinRecepcion)}`);
  for (const f of c.cfdisSinRecepcion) console.log(`   ${fmt(f.monto).padStart(12)}  ${dia(f.fecha)} ${f.referencia.padEnd(14)} ${(f.proveedor ?? "").slice(0, 40)} · ${f.renglones} insumo(s)`);
  console.log(`\n── Devoluciones al proveedor (esperan nota de crédito): ${c.devolucionesAProveedor.length} por ${fmt(c.totales.devolucionesAProveedor)}`);
  for (const d of c.devolucionesAProveedor) console.log(`   ${fmt(d.monto).padStart(12)}  ${dia(d.fecha)} ${d.insumo.slice(0, 40).padEnd(40)} ${d.lote ? `lote ${d.lote}` : ""} · ${d.proveedor ?? "sin proveedor"} · ${d.motivo ?? ""}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
