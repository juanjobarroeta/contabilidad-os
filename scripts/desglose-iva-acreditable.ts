/**
 * Desglose del IVA acreditable de un mes, renglón por renglón, contra la cifra
 * del motor (computeTaxPosition). SOLO LECTURA.
 *
 * Para qué: cuando el acuse del contador y el motor no cuadran, el total no
 * dice dónde está la diferencia. Esto reparte el acreditable del motor en sus
 * cubetas —PUE del mes pagados, PUE de meses anteriores pagados en éste, PPD por
 * REP, retenido del mes anterior, notas— con los renglones más grandes de cada
 * una, y marca lo sospechoso: REPs repetidos, pagos bancarios que no se parecen
 * a la factura, PUE pagados dos veces. La suma de las cubetas se compara con la
 * del motor: si no cuadra, el desglose está mal y se dice.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/desglose-iva-acreditable.ts --company <RFC> --ejercicio 2026 --mes 8 [--contador 293236] [--top 15]
 *   … --solo-acuse   imprime sólo los renglones «etiqueta cifra» del IVA del acuse guardado
 *
 * `--contador` es el renglón «IVA ACREDITABLE» del acuse, que NO incluye lo
 * retenido el mes anterior (va en «otras cantidades a favor»).
 */
import { prisma } from "../src/lib/prisma";
import { computeTaxPosition } from "../src/lib/impuestos";
import { reconciliacionActiva } from "../src/lib/fiscal/conciliacion-pue";
import { aplicarFlujoPue, pagosPueDelPeriodo, puesAnterioresPagadosEnPeriodo } from "../src/lib/fiscal/iva-pue-flujo";
import { ivaAcreditableNetoDe } from "../src/lib/fiscal/iva-retenciones";
import { normalizarUuid } from "../src/lib/fiscal/uuid";
import { REP_VIGENTE } from "../src/lib/fiscal/rep-vigente";
import { montosRepDelPadre, type LinkRep } from "../src/lib/fiscal/rep-tope";
import { linksVigentesAntesDe } from "../src/lib/fiscal/rep-tope-db";
import { textoDePdf } from "../src/lib/fiscal/fuentes/texto";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n: number) => Math.round(n * 100) / 100;

type Renglon = { monto: number; texto: string };

function cubeta(titulo: string, renglones: Renglon[], top: number) {
  const total = renglones.reduce((s, r) => s + r.monto, 0);
  console.log(`\n── ${titulo}: ${fmt(total)}  (${renglones.length} renglones)`);
  for (const r of [...renglones].sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto)).slice(0, top)) {
    console.log(`   ${fmt(r.monto).padStart(12)}  ${r.texto}`);
  }
  return total;
}

async function imprimirAcuse(companyId: string, year: number, month: number) {
  // ── 3c. Lo que dice el acuse guardado sobre IVA ────────────────────────────
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const decl = await prisma.taxDeclaration.findFirst({
    where: { companyId, periodo, tipo: "IVA_MENSUAL", acusePdf: { not: null } },
    select: { acusePdf: true, acusePdfNombre: true },
  });
  if (decl?.acusePdf) {
    const texto = await textoDePdf(Buffer.from(decl.acusePdf));
    // La sección del IVA, completa: desde su encabezado hasta el siguiente impuesto.
    const lineas = texto.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const ini = lineas.findIndex((l) => /IMPUESTO AL VALOR AGREGADO|DETERMINACI[ÓO]N DEL IMPUESTO AL VALOR/i.test(l));
    console.log(`\n── Acuse guardado (${decl.acusePdfNombre ?? "sin nombre"}): sección del IVA`);
    if (ini < 0) console.log("   (no se encontró la sección del IVA en el texto del PDF)");
    else {
      // Sin encabezados repetidos de página ni las tablas de facturas: sólo los
      // renglones con cifra, desde el IVA acreditable hasta el total a cargo/favor.
      const ruido = /^(RFC:|Denominaci|Tipo de declaraci|Periodicidad|Ejercicio:|Medio de presentaci|Versi[óo]n:|Hoja \d|--|Declaraci[óo]n Provisional)/i;
      const acred = lineas.findIndex((l, i) => i > ini && /ACREDITABLE/i.test(l));
      const desde = acred > 0 ? acred - 2 : ini;
      const fin = lineas.findIndex((l, i) => i > desde + 10 && /Impuesto Especial|IEPS|Impuesto sobre la renta|ISR retenciones/i.test(l));
      // Sólo los renglones «ETIQUETA  cifra»: las tablas de facturas del precargado se omiten.
      const renglon = /^[A-ZÁÉÍÓÚÑ(][A-ZÁÉÍÓÚÑ0-9 ,.%()"«»\-–/]+ -?[\d,]+$/;
      for (const l of lineas.slice(desde, fin > desde ? fin : undefined)) if (!ruido.test(l) && renglon.test(l)) console.log(`   ${l}`);
    }
  } else {
    console.log(`\n── Sin acuse PDF guardado para ${periodo}`);
  }
}

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  const contador = arg("contador") != null ? Number(arg("contador")) : null;
  const top = Number(arg("top") ?? 15);
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/desglose-iva-acreditable.ts --company <RFC> --ejercicio <AAAA> --mes <M> [--contador <monto>] [--top 15]");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const companyId = company.id;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  if (process.argv.includes("--solo-acuse")) {
    await imprimirAcuse(companyId, year, month);
    await prisma.$disconnect();
    return;
  }
  const pos = await computeTaxPosition(companyId, year, month);
  const modo = (await reconciliacionActiva(companyId)) ? "FLUJO" : "SUPUESTO_PAGADO";
  console.log(`${company.razonSocial} (${rfc}) — ${year}-${String(month).padStart(2, "0")} · modo PUE ${modo}`);

  type Numerico = {
    total: number;
    subtotal: number;
    totalImpuestos: number;
    taxes: { tipo: string; retencion: boolean; importe: number; base: number | null }[];
  };
  const conv = <T extends { total: unknown; subtotal: unknown; totalImpuestos: unknown; taxes: { tipo: string; retencion: boolean; importe: unknown; base: unknown }[] }>(
    inv: T,
  ): Omit<T, keyof Numerico> & Numerico => ({
    ...inv,
    total: Number(inv.total),
    subtotal: Number(inv.subtotal),
    totalImpuestos: Number(inv.totalImpuestos),
    taxes: inv.taxes.map((t) => ({ tipo: t.tipo, retencion: t.retencion, importe: Number(t.importe), base: t.base === null ? null : Number(t.base) })),
  });
  const etiqueta = (inv: { fecha: Date; uuid: string | null; total: number; customer?: { rfc: string | null } | null }) =>
    `${inv.fecha.toISOString().slice(0, 10)} ${(inv.uuid ?? "").slice(0, 8)} ${(inv.customer?.rfc ?? "").padEnd(13)} total ${fmt(inv.total)}`;

  // ── 1. PUE del mes ─────────────────────────────────────────────────────────
  const egresos = (
    await prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { taxes: true, customer: { select: { rfc: true } } },
    })
  ).map(conv);
  const pues = egresos.filter((i) => i.metodoPago === "PUE" && i.tipoSat !== "E" && !i.ivaNoAcreditable);
  const pagos = modo === "FLUJO" ? await pagosPueDelPeriodo(pues.map((i) => i.id), from, to) : new Map();
  const rPue: Renglon[] = [];
  let sinPago = 0;
  for (const inv of pues) {
    const p = pagos.get(inv.id) ?? null;
    const r = aplicarFlujoPue({ total: inv.total, ivaNeto: ivaAcreditableNetoDe(inv) }, p, modo);
    if (r.estado === "SIN_PAGO") { sinPago += ivaAcreditableNetoDe(inv); continue; }
    rPue.push({ monto: r.acreditable, texto: `${etiqueta(inv)} · ${r.estado} pagado ${fmt(p?.pagadoEnPeriodo ?? 0)}` });
  }
  const tPue = cubeta("PUE del mes, pagados en el mes", rPue, top);
  console.log(`   (PUE del mes SIN pago en el banco: IVA ${fmt(sinPago)} — no se acredita)`);

  // ── 2. PUE de meses anteriores pagados en éste ───────────────────────────
  const anteriores = modo === "FLUJO" ? await puesAnterioresPagadosEnPeriodo(companyId, from, to) : new Map();
  const padres = anteriores.size
    ? (await prisma.invoice.findMany({
        where: { id: { in: [...anteriores.keys()] }, ivaNoAcreditable: false },
        include: { taxes: true, customer: { select: { rfc: true } } },
      })).map(conv).filter((i) => i.tipoSat !== "E")
    : [];
  const rAnt: Renglon[] = [];
  for (const inv of padres) {
    const p = anteriores.get(inv.id)!;
    const r = aplicarFlujoPue({ total: inv.total, ivaNeto: ivaAcreditableNetoDe(inv) }, p, modo);
    const raro = p.pagadoEnPeriodo > inv.total * 1.05 ? " ⚠ pagado > total" : "";
    rAnt.push({ monto: r.acreditable, texto: `${etiqueta(inv)} · pagado en el mes ${fmt(p.pagadoEnPeriodo)}${raro}` });
  }
  const tAnt = cubeta("PUE de meses ANTERIORES pagados en este mes", rAnt, top);

  // ¿Alguno de esos ya se había pagado (y acreditado) en su propio mes?
  if (padres.length) {
    const previos = await pagosPueDelPeriodo(padres.map((i) => i.id), new Date(Date.UTC(2000, 0, 1)), from);
    const dobles = padres.filter((i) => (previos.get(i.id)?.pagadoEnPeriodo ?? 0) >= i.total - 0.5);
    if (dobles.length) {
      console.log(`   ⚠ ${dobles.length} de ellos YA estaban pagados completos antes de este mes (¿doble conciliación?):`);
      for (const i of dobles.slice(0, top)) console.log(`     ${etiqueta(i)} · pagado antes ${fmt(previos.get(i.id)!.pagadoEnPeriodo)}`);
    }
  }

  // ── 3. PPD por REP — igual que el motor: sólo REPs vigentes (no sustituidos)
  //       y acotados por factura a su IVA menos lo que tomaron meses anteriores.
  const links = (
    await prisma.pagoDoctoRelacionado.findMany({
      where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, ...REP_VIGENTE } },
      select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true, pagoInvoice: { select: { uuid: true } } },
    })
  ).map((l) => ({ ...l, impPagado: l.impPagado === null ? null : Number(l.impPagado), ivaTrasladado: l.ivaTrasladado === null ? null : Number(l.ivaTrasladado) }));
  const sustituidos = await prisma.pagoDoctoRelacionado.count({
    where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED", sustituidoPorUuid: { not: null } } },
  });
  const uuids = [...new Set(links.map((l) => l.parentUuid))];
  const ppd = (
    await prisma.invoice.findMany({
      where: { companyId, uuid: { in: uuids, mode: "insensitive" }, metodoPago: "PPD", status: "STAMPED", tipo: "EGRESO" },
      include: { taxes: true, customer: { select: { rfc: true } } },
    })
  ).map(conv);
  const porUuid = new Map(ppd.map((p) => [normalizarUuid(p.uuid!), p]));
  const delMes = new Map<string, (LinkRep & { rep: string })[]>();
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    if (!porUuid.has(k)) continue;
    delMes.set(k, [...(delMes.get(k) ?? []), { impPagado: l.impPagado, ivaTrasladado: l.ivaTrasladado, ivaDerivado: l.ivaDerivado, rep: (l.pagoInvoice?.uuid ?? "").slice(0, 8) }]);
  }
  const previos = await linksVigentesAntesDe(companyId, delMes.keys(), from);
  const rPpd: Renglon[] = [];
  const recortes: string[] = [];
  for (const [k, ls] of delMes) {
    const parent = porUuid.get(k)!;
    if (parent.ivaNoAcreditable) continue;
    const signo = parent.tipoSat === "E" ? -1 : 1;
    const m = montosRepDelPadre(parent, previos.get(k) ?? [], ls);
    const monto = Math.max(0, signo * m.iva - signo * m.ivaRetenido);
    rPpd.push({ monto, texto: `${etiqueta(parent)} · REPs ${ls.map((x) => `${x.rep}:${fmt(x.impPagado ?? 0)}`).join(" ")}` });
    if (m.recortado) {
      const sinTope = montosRepDelPadre(parent, [], ls);
      const prev = previos.get(k) ?? [];
      recortes.push(
        `   ${fmt(Math.max(0, sinTope.iva - sinTope.ivaRetenido) - monto).padStart(10)} recortado · ${etiqueta(parent)} · IVA factura ${fmt(ivaAcreditableNetoDe(parent))}` +
          ` · meses anteriores: ${prev.length} pago(s) por ${fmt(prev.reduce((s2, x) => s2 + (x.impPagado ?? 0), 0))} · este mes: ${ls.map((x) => `${x.rep} ${fmt(x.impPagado ?? 0)}`).join(", ")}`,
      );
    }
  }
  const tPpd = cubeta("PPD pagados en el mes (por REP vigente, con tope por factura)", rPpd, top);
  console.log(`   (REPs sustituidos que ya NO cuentan en el mes: ${sustituidos})`);
  if (recortes.length) {
    console.log(`\n── Facturas donde el TOPE recortó (${recortes.length}):`);
    for (const r of recortes) console.log(r);
  }

  // ── ISR: lo facturado en el mes (emitidas), bruto y neto de descuento ─────
  const emit = await prisma.invoice.groupBy({
    by: ["tipoSat", "metodoPago"],
    where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
    _sum: { subtotal: true, descuento: true },
    _count: { id: true },
  });
  console.log(`\n── Emitidas del mes (para el ISR)`);
  for (const g of emit) {
    console.log(`   tipo ${g.tipoSat ?? "?"} ${g.metodoPago}: ${g._count.id} CFDIs · subtotal ${fmt(Number(g._sum.subtotal ?? 0))} · descuento ${fmt(Number(g._sum.descuento ?? 0))}`);
  }
  const deTipo = (t: string) => emit.filter((g) => (g.tipoSat ?? "I") === t);
  const sub = (t: string) => deTipo(t).reduce((a, g) => a + Number(g._sum.subtotal ?? 0), 0);
  const des = (t: string) => deTipo(t).reduce((a, g) => a + Number(g._sum.descuento ?? 0), 0);
  console.log(`   I bruto ${fmt(sub("I"))} · I neto de descuento ${fmt(sub("I") - des("I"))} · E ${fmt(sub("E"))}`);
  await imprimirAcuse(companyId, year, month);

  // ── 4. Lo demás, del motor ───────────────────────────────────────────────
  const iva = pos.iva;
  const motor = iva.acreditable;
  const notas = iva.notasCreditoRecibidas.iva;
  const retAnt = iva.retenidoMesAnteriorAcreditable;
  const devengado = iva.devengado.acreditable;
  const suma = r2(tPue + tAnt + tPpd - notas + retAnt);

  console.log(`\n── Resumen`);
  console.log(`   PUE del mes pagados       ${fmt(tPue).padStart(14)}`);
  console.log(`   PUE anteriores pagados    ${fmt(tAnt).padStart(14)}`);
  console.log(`   PPD por REP               ${fmt(tPpd).padStart(14)}`);
  console.log(`   Retenido mes anterior     ${fmt(retAnt).padStart(14)}`);
  console.log(`   − Notas recibidas         ${fmt(notas).padStart(14)}`);
  console.log(`   = Suma del desglose       ${fmt(suma).padStart(14)}`);
  console.log(`   Motor, bruto              ${fmt(iva.acreditableBruto).padStart(14)}${Math.abs(suma - iva.acreditableBruto) > 1 ? `   ⚠ el desglose NO cuadra con el motor (Δ ${fmt(suma - iva.acreditableBruto)}; p. ej. proveedores 69-B) — revisar antes de concluir` : "   ✓ cuadra"}`);
  console.log(`   × proporción ${iva.proporcionAcreditamiento} = acreditable del motor ${fmt(motor)}`);
  console.log(`   Devengado (todo lo recibido en el mes, sin importar pago) ${fmt(devengado)}`);
  // La forma del SAT NO mete lo retenido el mes anterior en «IVA acreditable»:
  // lo lleva como «OTRAS CANTIDADES A FAVOR DEL CONTRIBUYENTE» (visto en el
  // acuse de agosto 2026 de CENTRO). Para comparar renglón contra renglón:
  console.log(`   Como la forma del SAT: IVA acreditable ${fmt(r2(motor - retAnt))} + otras cantidades a favor ${fmt(retAnt)}`);
  if (contador != null) console.log(`   Contador ${fmt(contador)} (renglón «IVA acreditable») · motor − contador = ${fmt(r2(motor - retAnt - contador))}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
