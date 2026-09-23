/**
 * Depósitos del mes que NO están amparados por un CFDI del mes: lo que un
 * contador suma como «INGRESOS NOMINALES ADICIONALES» en el pago provisional.
 * SOLO LECTURA.
 *
 * Reparte cada abono bancario del mes en:
 *   - cobro de una factura del mes          → ya está en «ingresos facturados»
 *   - cobro de una factura de meses previos → cobranza, no ingreso nuevo
 *   - cobrado ANTES de facturar (la factura es posterior al mes) → ingreso del mes sin CFDI del mes
 *   - anticipo de cliente sin CFDI (etiquetado)
 *   - intereses / rendimientos
 *   - traspasos entre cuentas propias, préstamos, otros etiquetados
 *   - sin conciliar
 * y compara las cubetas candidatas (sin IVA al 16 % y al 0 %) contra la cifra
 * del acuse.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/depositos-sin-cfdi.ts --company <RFC> --ejercicio 2026 --mes 8 [--acuse 22597] [--top 20]
 */
import { prisma } from "../src/lib/prisma";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTERES = /INTER[EÉ]S|RENDIMIENTO|INT\.? ?GANADO|INT\.? ?PAGADO|INVERSI[OÓ]N.*(VENC|RENDIM)/i;

type Mov = { id: string; fecha: Date; monto: number; descripcion: string; cuenta: string; contraparte: string };

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  const acuse = arg("acuse") != null ? Number(arg("acuse")) : null;
  const top = Number(arg("top") ?? 20);
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/depositos-sin-cfdi.ts --company <RFC> --ejercicio <AAAA> --mes <M> [--acuse <monto>] [--top 20]");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const txs = await prisma.bankTransaction.findMany({
    where: { companyId: company.id, fecha: { gte: from, lt: to }, monto: { gt: 0 } },
    select: {
      id: true, fecha: true, monto: true, descripcion: true, status: true, notes: true, contraparteNombre: true, contraparteRfc: true,
      bankAccount: { select: { banco: true, numeroCuenta: true } },
      invoice: { select: { fecha: true, tipo: true } },
    },
    orderBy: { fecha: "asc" },
  });
  const detalles = await prisma.conciliacionDetalle.findMany({
    where: { bankTransactionId: { in: txs.map((t) => t.id) } },
    select: { bankTransactionId: true, montoAsignado: true, invoice: { select: { fecha: true, tipo: true } } },
  });
  const detPorTx = new Map<string, typeof detalles>();
  for (const d of detalles) detPorTx.set(d.bankTransactionId, [...(detPorTx.get(d.bankTransactionId) ?? []), d]);

  const cubetas = new Map<string, Mov[]>();
  const poner = (k: string, m: Mov) => cubetas.set(k, [...(cubetas.get(k) ?? []), m]);
  const cuando = (f: Date) => (f < from ? "previa" : f >= to ? "posterior" : "delMes");

  for (const t of txs) {
    const base: Mov = {
      id: t.id,
      fecha: t.fecha,
      monto: Number(t.monto),
      descripcion: t.descripcion.replace(/\s+/g, " ").slice(0, 70),
      cuenta: `${t.bankAccount?.banco ?? ""} ${(t.bankAccount?.numeroCuenta ?? "").slice(-4)}`.trim(),
      contraparte: (t.contraparteNombre ?? t.contraparteRfc ?? "").slice(0, 30),
    };
    if (INTERES.test(t.descripcion) || t.notes === "INTERESES" || t.notes === "INTERES" || t.notes === "RENDIMIENTO") { poner("Intereses / rendimientos", base); continue; }
    if (t.status === "IGNORED") {
      const tag = t.notes ?? "(sin etiqueta)";
      if (tag === "ANTICIPO_CLIENTE") poner("Anticipo de cliente SIN CFDI (etiquetado)", base);
      else if (tag === "TRASPASO" || tag === "INTERNAL_TRANSFER") poner("Traspaso entre cuentas propias", base);
      else poner(`Ignorado: ${tag}`, base);
      continue;
    }
    if (t.status === "MATCHED") {
      const facturas = t.invoice ? [{ fecha: t.invoice.fecha, monto: Number(t.monto) }] : (detPorTx.get(t.id) ?? []).map((d) => ({ fecha: d.invoice.fecha, monto: Number(d.montoAsignado) }));
      if (facturas.length === 0) { poner("Conciliado sin factura ligada", base); continue; }
      let resto = base.monto;
      for (const f of facturas) {
        const parte = Math.min(resto, Math.abs(f.monto));
        resto -= parte;
        const k = { previa: "Cobro de factura de MESES PREVIOS", delMes: "Cobro de factura DEL MES", posterior: "Cobrado ANTES de facturar (factura posterior al mes)" }[cuando(f.fecha)];
        poner(k, { ...base, monto: parte });
      }
      if (resto > 0.5) poner("Conciliado: remanente sin factura", { ...base, monto: resto });
      continue;
    }
    poner("SIN conciliar", base);
  }

  console.log(`${company.razonSocial} (${rfc}) — depósitos de ${year}-${String(month).padStart(2, "0")}: ${txs.length} abonos por ${fmt(txs.reduce((s, t) => s + Number(t.monto), 0))}`);
  const orden = [
    "Cobro de factura DEL MES",
    "Cobro de factura de MESES PREVIOS",
    "Cobrado ANTES de facturar (factura posterior al mes)",
    "Anticipo de cliente SIN CFDI (etiquetado)",
    "Intereses / rendimientos",
    "SIN conciliar",
    "Conciliado: remanente sin factura",
    "Conciliado sin factura ligada",
    "Traspaso entre cuentas propias",
  ];
  const claves = [...orden.filter((k) => cubetas.has(k)), ...[...cubetas.keys()].filter((k) => !orden.includes(k))];
  const total = (k: string) => (cubetas.get(k) ?? []).reduce((s, m) => s + m.monto, 0);
  for (const k of claves) {
    const ms = cubetas.get(k)!;
    console.log(`\n── ${k}: ${fmt(total(k))}  (${ms.length})`);
    const detalle = !k.startsWith("Cobro de factura");
    if (detalle) for (const m of [...ms].sort((a, b) => b.monto - a.monto).slice(0, top)) {
      console.log(`   ${fmt(m.monto).padStart(12)}  ${m.fecha.toISOString().slice(0, 10)} ${m.cuenta.padEnd(12)} ${m.contraparte.padEnd(30)} ${m.descripcion}`);
    }
  }

  // Candidatos a «ingresos nominales adicionales»: lo cobrado en el mes sin CFDI del mes.
  const cand: [string, number][] = [
    ["Intereses", total("Intereses / rendimientos")],
    ["Anticipos etiquetados", total("Anticipo de cliente SIN CFDI (etiquetado)")],
    ["Cobrado antes de facturar", total("Cobrado ANTES de facturar (factura posterior al mes)")],
    ["Sin conciliar", total("SIN conciliar") + total("Conciliado: remanente sin factura") + total("Conciliado sin factura ligada")],
  ];
  console.log(`\n── Candidatos a «ingresos nominales adicionales» (sin IVA)`);
  for (const [n, v] of cand) console.log(`   ${n.padEnd(28)} bruto ${fmt(v).padStart(12)} · ÷1.16 ${fmt(v / 1.16).padStart(12)}`);
  if (acuse != null) {
    // ¿Qué combinación se acerca? Intereses van sin IVA; lo demás, al 16 % o al 0 %.
    const combos: [string, number][] = [];
    const n = cand.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      for (const div of [1, 1.16]) {
        let v = 0;
        const partes: string[] = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) {
          v += i === 0 ? cand[i][1] : cand[i][1] / div;
          partes.push(i === 0 ? cand[i][0] : `${cand[i][0]}${div === 1.16 ? " ÷1.16" : ""}`);
        }
        combos.push([partes.join(" + "), v]);
      }
    }
    combos.sort((a, b) => Math.abs(a[1] - acuse) - Math.abs(b[1] - acuse));
    console.log(`\n── Lo más cercano a ${fmt(acuse)} del acuse`);
    for (const [k, v] of combos.slice(0, 5)) console.log(`   ${fmt(v).padStart(12)}  (Δ ${fmt(v - acuse)})  ${k}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
