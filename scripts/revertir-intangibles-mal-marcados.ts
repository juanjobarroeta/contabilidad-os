// ─────────────────────────────────────────────────────────────────────────────
// DESHACER: los activos que quedaron marcados INTANGIBLE sin serlo.
//
// Una corrida del reparador con la regla vieja —que aceptaba el NOMBRE como
// evidencia— reclasificó laptops, un tomógrafo y un lector de huellas. Esto los
// devuelve a su tipo, recalculándolo del CFDI que los creó, y deja intangibles
// sólo los que tienen evidencia fuerte: la clave del CFDI dice «Software»
// (familia 4323) y el nombre no dice que sea una cosa física.
//
//   npx tsx scripts/revertir-intangibles-mal-marcados.ts            (simulacro)
//   npx tsx scripts/revertir-intangibles-mal-marcados.ts --aplicar
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { clasificarCfdi } from "../src/lib/fiscal/clasificar-cfdi";
import { TASA_DEPRECIACION, tipoActivoDesdeSubtipo } from "../src/lib/fiscal/depreciacion";

const prisma = new PrismaClient();

const CLAVE_SOFTWARE = "4323";
const PALABRAS_HARDWARE =
  /laptop|notebook|servidor|computadora|\baio\b|pantalla|monitor|impresora|procesador|tom[oó]grafo|equipo|enrolador|esc[aá]ner|tel[eé]fono|celular|tablet|disco|memoria|teclado|mouse/i;

async function main() {
  const aplicar = process.argv.includes("--aplicar");

  const activos = await prisma.activoFijo.findMany({
    where: { tipo: "intangible", autoCreado: true },
    select: { id: true, companyId: true, descripcion: true, invoiceId: true, tasaAnual: true },
  });

  const facturas = new Map(
    (
      await prisma.invoice.findMany({
        where: { id: { in: activos.map((a) => a.invoiceId).filter((x): x is string => !!x) } },
        select: { id: true, tipo: true, usoCfdi: true, items: { select: { claveProdServ: true, importe: true, descripcion: true } } },
      })
    ).map((f) => [f.id, f]),
  );
  const empresas = new Map(
    (
      await prisma.company.findMany({
        where: { id: { in: [...new Set(activos.map((a) => a.companyId))] } },
        select: { id: true, razonSocial: true },
      })
    ).map((c) => [c.id, c.razonSocial]),
  );

  let quedan = 0;
  const revertir: Array<{ id: string; tipo: string; tasa: number; linea: string }> = [];

  for (const a of activos) {
    const f = a.invoiceId ? facturas.get(a.invoiceId) : null;
    const claves = (f?.items ?? []).map((it) => it.claveProdServ ?? "");
    const esSoftware = claves.some((c) => c.startsWith(CLAVE_SOFTWARE));
    if (esSoftware && !PALABRAS_HARDWARE.test(a.descripcion)) { quedan++; continue; }

    // Su tipo real: el que el CFDI declara, con el clasificador de hoy.
    const clasif = f
      ? clasificarCfdi({
          tipo: f.tipo,
          usoCfdi: f.usoCfdi ?? null,
          items: (f.items ?? []).map((it) => ({ claveProdServ: it.claveProdServ, importe: Number(it.importe), descripcion: it.descripcion })),
        })
      : null;
    let tipo = tipoActivoDesdeSubtipo(clasif?.subtipoInversion);
    // Si el CFDI también dice intangible pero el nombre grita hardware, el
    // nombre gana: es justo el caso del servidor facturado bajo software.
    if (tipo === "intangible") tipo = /tom[oó]grafo|enrolador|equipo|maquinaria/i.test(a.descripcion) ? "maquinaria" : "computo";

    revertir.push({
      id: a.id,
      tipo,
      tasa: TASA_DEPRECIACION[tipo].tasa,
      linea: `  ${(empresas.get(a.companyId) ?? a.companyId).slice(0, 28).padEnd(28)} ${a.descripcion.replace(/\s+/g, " ").slice(0, 46).padEnd(46)} intangible 15% → ${tipo} ${(TASA_DEPRECIACION[tipo].tasa * 100).toFixed(0)}%`,
    });
  }

  console.log(`${activos.length} activos marcados intangible · ${quedan} se quedan (evidencia fuerte) · ${revertir.length} se devuelven\n`);
  for (const r of revertir) console.log(r.linea);

  if (!aplicar) { console.log(`\nSimulacro. Para escribir: --aplicar`); return; }
  for (const r of revertir) {
    await prisma.activoFijo.update({ where: { id: r.id }, data: { tipo: r.tipo, tasaAnual: r.tasa } });
  }
  console.log(`\n${revertir.length} activos devueltos a su tipo.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
