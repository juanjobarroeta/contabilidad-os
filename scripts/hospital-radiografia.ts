// Radiografía de sólo lectura de una empresa en el hub: qué hay para modelar.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RFC = process.argv[2];
async function main() {
  const c = await prisma.company.findUnique({ where: { rfc: RFC }, select: { id: true, razonSocial: true, nombreComercial: true, regimenFiscal: true, codigoPostal: true, createdAt: true, modules: { select: { modulo: true, habilitado: true } }, members: { select: { role: true, user: { select: { email: true } } } } } });
  if (!c) { console.log("NO EXISTE", RFC); return; }
  console.log(JSON.stringify({ ...c, members: c.members.map((m) => `${m.user.email}:${m.role}`) }, null, 1));
  const cid = c.id;
  const porTipo = await prisma.invoice.groupBy({ by: ["tipo", "status"], where: { companyId: cid }, _count: { _all: true }, _sum: { total: true } });
  console.log("CFDIs por tipo/status:", porTipo.map((r) => `${r.tipo}/${r.status}: ${r._count._all} · $${Math.round(Number(r._sum.total ?? 0)).toLocaleString("en-US")}`).join(" | "));
  const rango = await prisma.invoice.aggregate({ where: { companyId: cid }, _min: { fecha: true }, _max: { fecha: true } });
  console.log("rango:", rango._min.fecha?.toISOString().slice(0, 10), "→", rango._max.fecha?.toISOString().slice(0, 10));
  const conXml = await prisma.invoice.count({ where: { companyId: cid, rawXml: { not: null } } });
  const conItems = await prisma.invoice.count({ where: { companyId: cid, items: { some: {} } } });
  console.log("con rawXml:", conXml, "· con items:", conItems);
  const topCli = await prisma.invoice.groupBy({ by: ["customerId"], where: { companyId: cid, tipo: "INGRESO", status: { not: "CANCELLED" }, customerId: { not: null } }, _count: { _all: true }, _sum: { total: true }, orderBy: { _sum: { total: "desc" } }, take: 15 });
  const clis = await prisma.customer.findMany({ where: { id: { in: topCli.map((t) => t.customerId!) } }, select: { id: true, razonSocial: true, rfc: true } });
  console.log("TOP CLIENTES (INGRESO):"); for (const t of topCli) { const k = clis.find((x) => x.id === t.customerId); console.log(`  ${k?.razonSocial} [${k?.rfc}] · ${t._count._all} fact · $${Math.round(Number(t._sum.total)).toLocaleString("en-US")}`); }
  const topProv = await prisma.invoice.groupBy({ by: ["customerId"], where: { companyId: cid, tipo: "EGRESO", status: { not: "CANCELLED" }, customerId: { not: null } }, _count: { _all: true }, _sum: { total: true }, orderBy: { _sum: { total: "desc" } }, take: 15 });
  const provs = await prisma.customer.findMany({ where: { id: { in: topProv.map((t) => t.customerId!) } }, select: { id: true, razonSocial: true, rfc: true } });
  console.log("TOP PROVEEDORES (EGRESO):"); for (const t of topProv) { const k = provs.find((x) => x.id === t.customerId); console.log(`  ${k?.razonSocial} [${k?.rfc}] · ${t._count._all} fact · $${Math.round(Number(t._sum.total)).toLocaleString("en-US")}`); }
  // Personas físicas que nos facturan con retención de ISR → candidatos a médicos
  const pf = await prisma.$queryRaw<Array<{ rfc: string; razon: string; facturas: number; total: number; isr: number }>>`
    SELECT c.rfc, c."razonSocial" AS razon, COUNT(DISTINCT i.id)::int AS facturas, SUM(i.total)::float8 AS total,
           COALESCE(SUM(t.importe) FILTER (WHERE t.tipo = 'ISR' AND t.retencion), 0)::float8 AS isr
    FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
    LEFT JOIN "InvoiceTax" t ON t."invoiceId" = i.id
    WHERE i."companyId" = ${cid} AND i.tipo = 'EGRESO' AND i.status <> 'CANCELLED' AND LENGTH(c.rfc) = 13
    GROUP BY c.rfc, c."razonSocial" ORDER BY total DESC LIMIT 25`;
  console.log("PERSONAS FÍSICAS que facturan (candidatos a médicos):", pf.length); for (const p of pf) console.log(`  ${p.razon} [${p.rfc}] · ${p.facturas} fact · $${Math.round(p.total).toLocaleString("en-US")} · ISR ret $${Math.round(p.isr).toLocaleString("en-US")}`);
  const claves = await prisma.$queryRaw<Array<{ pref: string; n: number; importe: number }>>`
    SELECT LEFT(it."claveProdServ", 2) AS pref, COUNT(*)::int AS n, SUM(it.importe)::float8 AS importe
    FROM "InvoiceItem" it JOIN "Invoice" i ON i.id = it."invoiceId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'EGRESO' AND i.status <> 'CANCELLED'
    GROUP BY 1 ORDER BY importe DESC LIMIT 15`;
  console.log("EGRESO conceptos por prefijo de clave:", claves.map((k) => `${k.pref}:${k.n}($${Math.round(k.importe / 1000)}k)`).join(" "));
  const topIng = await prisma.$queryRaw<Array<{ desc: string; clave: string; n: number; importe: number; pu: number }>>`
    SELECT it.descripcion AS "desc", it."claveProdServ" AS clave, COUNT(*)::int AS n, SUM(it.importe)::float8 AS importe, AVG(it."valorUnitario")::float8 AS pu
    FROM "InvoiceItem" it JOIN "Invoice" i ON i.id = it."invoiceId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'INGRESO' AND i.status <> 'CANCELLED'
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`;
  console.log("INGRESO conceptos más frecuentes (candidatos a tarifario):"); for (const t of topIng) console.log(`  ${t.n}× ${t.desc.slice(0, 70)} [${t.clave}] · pu $${Math.round(t.pu).toLocaleString("en-US")}`);
  const ce = await prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId: cid }, _count: { _all: true } });
  console.log("CE balanzas:", ce.length, ce.length ? `${ce[0].anio}-${ce[0].mes} … ${ce[ce.length - 1].anio}-${ce[ce.length - 1].mes}` : "");
  console.log("empleados:", await prisma.employee.count({ where: { companyId: cid } }), "activos:", await prisma.employee.count({ where: { companyId: cid, isActive: true } }));
  console.log("cuentas bancarias:", await prisma.bankAccount.count({ where: { companyId: cid } }), "movimientos:", await prisma.bankTransaction.count({ where: { companyId: cid } }));
  console.log("nómina CFDIs:", await prisma.invoice.count({ where: { companyId: cid, tipo: "NOMINA" } }));
  console.log("Hosp*: insumos", await prisma.hospInsumo.count({ where: { companyId: cid } }), "pacientes", await prisma.hospPaciente.count({ where: { companyId: cid } }));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
