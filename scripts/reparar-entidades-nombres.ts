// Decodifica entidades XML (&amp; &quot; &apos; &lt; &gt; &#NN;) que quedaron
// literales en nombres del padrón y de las facturas. Idempotente; --apply escribe.
import { prisma } from "../src/lib/prisma";
const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const apply = process.argv.includes("--apply");
async function main() {
  const where = { OR: ["&amp;", "&quot;", "&apos;", "&lt;", "&gt;", "&#"].map((e) => ({ contains: e })) };
  const clientes = await prisma.customer.findMany({ where: { OR: where.OR.map((o) => ({ razonSocial: o })) }, select: { id: true, razonSocial: true } });
  let nC = 0;
  for (const c of clientes) { const v = decode(c.razonSocial); if (v !== c.razonSocial) { nC++; if (apply) await prisma.customer.update({ where: { id: c.id }, data: { razonSocial: v } }); } }
  const facturas = await prisma.invoice.findMany({ where: { OR: where.OR.map((o) => ({ contraparteNombre: o })) }, select: { id: true, contraparteNombre: true } });
  let nF = 0;
  for (const f of facturas) { const v = decode(f.contraparteNombre ?? ""); if (v !== f.contraparteNombre) { nF++; if (apply) await prisma.invoice.update({ where: { id: f.id }, data: { contraparteNombre: v } }); } }
  console.log(`${apply ? "REPARADOS" : "A reparar"}: Customer.razonSocial ${nC} · Invoice.contraparteNombre ${nF}`);
  console.log("ejemplo:", clientes[0]?.razonSocial, "→", clientes[0] ? decode(clientes[0].razonSocial) : "");
}
main().finally(() => prisma.$disconnect());
