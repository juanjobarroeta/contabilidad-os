/**
 * Cotejo del IVA acreditable antes/después de la regla de notas de crédito
 * recibidas (Art. 7 LIVA, src/lib/fiscal/iva-notas-credito.ts). SÓLO LECTURA.
 *
 * Imprime el acreditable del motor con la regla nueva, reconstruye el de antes
 * (la nota pasaba por la regla de pago del PUE y, en FLUJO, sin movimiento en
 * el banco restaba 0), y lista cada nota del mes con lo que resta y por qué.
 * Con --contador compara contra la cifra del acuse.
 *
 * Caso que lo motivó: CENTRO (CPM2307076Z9), agosto 2026 — contador 293,236
 * contra motor 302,376 (diferencia 9,140).
 *
 * Uso: DATABASE_URL=… npx tsx scripts/cotejo-iva-notas.ts --company CPM2307076Z9 --ejercicio 2026 --mes 8 [--contador 293236]
 *
 * «Antes» es una reconstrucción del mes: no incluye el cambio en los PUE de
 * meses anteriores pagados en éste (hoy también se juzgan contra su total neto
 * de notas), que en un mes normal es cero o casi.
 */
import { prisma } from "../src/lib/prisma";
import { computeTaxPosition } from "../src/lib/impuestos";
import { reconciliacionActiva } from "../src/lib/fiscal/conciliacion-pue";
import { aplicarFlujoPue, pagosPueDelPeriodo } from "../src/lib/fiscal/iva-pue-flujo";
import { ivaAcreditableNetoDe } from "../src/lib/fiscal/iva-retenciones";
import {
  notasRecibidasPorPadre,
  padresDeNotasRecibidas,
  reduccionPorNotaRecibida,
  totalNetoDeNotas,
} from "../src/lib/fiscal/iva-notas-credito";
import { normalizarUuid } from "../src/lib/fiscal/uuid";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  const contador = arg("contador") != null ? Number(arg("contador")) : null;
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/cotejo-iva-notas.ts --company <RFC> --ejercicio <AAAA> --mes <M> [--contador <monto>]");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);

  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const pos = await computeTaxPosition(company.id, year, month);
  const modo = (await reconciliacionActiva(company.id)) ? "FLUJO" : "SUPUESTO_PAGADO";

  const egresos = (
    await prisma.invoice.findMany({
      where: { companyId: company.id, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { taxes: true },
    })
  ).map((inv) => ({
    ...inv,
    total: Number(inv.total),
    subtotal: Number(inv.subtotal),
    totalImpuestos: Number(inv.totalImpuestos),
    taxes: inv.taxes.map((t) => ({ ...t, importe: Number(t.importe), base: t.base === null ? null : Number(t.base) })),
  }));
  // Mismos filtros que el motor (69-B aparte: ya viene reflejado en `pos`).
  const notas = egresos.filter((inv) => inv.tipoSat === "E" && !inv.ivaNoAcreditable);
  const pues = egresos.filter((inv) => inv.metodoPago === "PUE" && inv.tipoSat !== "E" && !inv.ivaNoAcreditable);

  // Antes: la nota PUE pasaba por aplicarFlujoPue y se restaba con signo.
  const pagosNotas = modo === "FLUJO" ? await pagosPueDelPeriodo(notas.map((n) => n.id), from, to) : new Map();
  const padres = await padresDeNotasRecibidas(company.id, notas);
  let antesNotas = 0;
  let ahoraNotas = 0;
  console.log(`\n${company.razonSocial} (${rfc}) — ${year}-${String(month).padStart(2, "0")} · modo PUE: ${modo}`);
  console.log(`\nNotas de crédito recibidas (${notas.length}):`);
  for (const n of notas) {
    const neto = ivaAcreditableNetoDe(n);
    const antes = n.metodoPago === "PUE" ? aplicarFlujoPue({ total: n.total, ivaNeto: neto }, pagosNotas.get(n.id) ?? null, modo).acreditable : 0;
    const r = reduccionPorNotaRecibida({ total: n.total, ivaNeto: neto }, padres.get(n.id) ?? []);
    antesNotas -= antes;
    ahoraNotas -= r.reduccion;
    const ps = (padres.get(n.id) ?? []).map((p) => `${p.uuid.slice(0, 8)}(${p.metodoPago})`).join(",") || "—";
    console.log(
      `  ${n.fecha.toISOString().slice(0, 10)} ${(n.uuid ?? "").slice(0, 8)} ${(n.contraparteRfc ?? "").padEnd(13)} total ${fmt(n.total).padStart(12)}  IVA neto ${fmt(neto).padStart(10)}  antes −${fmt(antes).padStart(10)}  ahora −${fmt(r.reduccion).padStart(10)}  ${r.estado}  padres ${ps}`,
    );
  }

  // PUE del mes cobrados netos de su nota: antes quedaban PARCIAL.
  let deltaPadres = 0;
  if (modo === "FLUJO") {
    const pagos = await pagosPueDelPeriodo(pues.map((p) => p.id), from, to);
    const porPadre = await notasRecibidasPorPadre(company.id, pues.map((p) => p.uuid), to, notas);
    for (const p of pues) {
      const conNotas = p.uuid ? porPadre.get(normalizarUuid(p.uuid)) ?? 0 : 0;
      if (conNotas <= 0) continue;
      const neto = ivaAcreditableNetoDe(p);
      const antes = aplicarFlujoPue({ total: p.total, ivaNeto: neto }, pagos.get(p.id) ?? null, modo).acreditable;
      const ahora = aplicarFlujoPue({ total: totalNetoDeNotas(p.total, conNotas), ivaNeto: neto }, pagos.get(p.id) ?? null, modo).acreditable;
      if (Math.abs(ahora - antes) > 0.005) {
        deltaPadres += ahora - antes;
        console.log(`  padre PUE ${(p.uuid ?? "").slice(0, 8)}: acreditable ${fmt(antes)} → ${fmt(ahora)} (cobrado neto de ${fmt(conNotas)} en notas)`);
      }
    }
  }

  const prop = pos.iva.proporcionAcreditamiento;
  const brutoAhora = pos.iva.acreditableBruto;
  const brutoAntes = brutoAhora - ahoraNotas + antesNotas - deltaPadres;
  const antes = Math.round(brutoAntes * prop * 100) / 100;
  const ahora = pos.iva.acreditable;
  console.log(`\nNotas: antes ${fmt(antesNotas)} · ahora ${fmt(ahoraNotas)} · padres PUE netos ${fmt(deltaPadres)} · proporción ${prop}`);
  console.log(`IVA acreditable  antes ${fmt(antes)}  →  ahora ${fmt(ahora)}   (Δ ${fmt(ahora - antes)})`);
  if (contador != null) {
    console.log(`Contador ${fmt(contador)}: diferencia antes ${fmt(antes - contador)} · ahora ${fmt(ahora - contador)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
