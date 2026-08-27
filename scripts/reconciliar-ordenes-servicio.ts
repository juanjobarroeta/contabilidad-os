/**
 * Reconcilia las órdenes de taller derivadas contra su ServicioVenta.
 *
 * «Nailed» con número, no con vibra: por cada OrdenServicio derivada, la suma de
 * sus líneas (mano de obra + refacciones) debe cuadrar contra el subtotal de la
 * ServicioVenta que la originó (manoObra + refacciones). Reporta el % que cuadra
 * al peso y ejemplos de los que no, para saber si el backfill es confiable antes
 * de mandarlo al wizard.
 *
 * Uso: DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> [TOL=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/reconciliar-ordenes-servicio.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const TOL = Number(process.env.TOL ?? 1); // pesos de tolerancia

async function main() {
  const prisma = new PrismaClient();
  try {
    const { id: COMPANY, razonSocial, rfc } = await resolverEmpresa(prisma);
    console.log(`Empresa: ${razonSocial ?? rfc} (${COMPANY})`);

    const ordenes = await prisma.ordenServicio.findMany({
      where: { companyId: COMPANY, servicioVentaId: { not: null } },
      select: {
        id: true, folio: true, servicioVentaId: true,
        lineas: { select: { tipo: true, cantidad: true, precioUnitario: true } },
      },
    });
    if (ordenes.length === 0) { console.log("Sin órdenes derivadas todavía."); return; }

    const svIds = ordenes.map((o) => o.servicioVentaId!) as string[];
    const svs = new Map(
      (await prisma.servicioVenta.findMany({
        where: { id: { in: svIds } },
        select: { id: true, total: true, manoObra: true, refacciones: true },
      })).map((s) => [s.id, s]),
    );

    let cuadran = 0, sinSV = 0;
    const fallos: string[] = [];
    for (const o of ordenes) {
      const sv = svs.get(o.servicioVentaId!);
      if (!sv) { sinSV++; continue; }
      const lineas = o.lineas.reduce((a, l) => a + Number(l.cantidad) * Number(l.precioUnitario), 0);
      const esperado = Number(sv.manoObra) + Number(sv.refacciones); // subtotal del servicio
      if (Math.abs(lineas - esperado) <= TOL) cuadran++;
      else if (fallos.length < 6)
        fallos.push(`  folio ${o.folio}: líneas $${Math.round(lineas).toLocaleString()} vs SV $${Math.round(esperado).toLocaleString()} (Δ ${Math.round(lineas - esperado)})`);
    }
    const n = ordenes.length;
    console.log(`\n${n.toLocaleString()} órdenes · cuadran al peso: ${cuadran.toLocaleString()} (${(cuadran / n * 100).toFixed(1)}%) · sin ServicioVenta: ${sinSV}`);
    if (fallos.length) { console.log("ejemplos que no cuadran:"); fallos.forEach((f) => console.log(f)); }
  } finally {
    await prisma.$disconnect();
  }
}

main();
