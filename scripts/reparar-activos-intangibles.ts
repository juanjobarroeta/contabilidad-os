// ─────────────────────────────────────────────────────────────────────────────
// REPARACIÓN: los intangibles que entraron como activo fijo.
//
// Un CFDI con usoCfdi I01–I08 creaba un ActivoFijo solo, y no existía la
// categoría de intangible: una licencia de software facturada con I04 quedó
// como equipo de cómputo depreciándose al 30 % (Art. 34-VII) cuando se amortiza
// al 15 % (Art. 33). Esto lo corrige en las empresas que YA lo tienen.
//
// Toca sólo los `autoCreado` —lo que capturó o revisó el contador es suyo— y
// sólo cuando la evidencia está en el CFDI: la clave de producto dice software.
// La bandera de revisión se queda puesta: perpetua (5 %), gasto diferido (15 %)
// o suscripción del periodo (que ni siquiera es activo) lo decide una persona.
//
//   npx tsx scripts/reparar-activos-intangibles.ts              (simulacro)
//   npx tsx scripts/reparar-activos-intangibles.ts --aplicar
//   npx tsx scripts/reparar-activos-intangibles.ts --empresa=<companyId>
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { TASA_DEPRECIACION } from "../src/lib/fiscal/depreciacion";

const prisma = new PrismaClient();

/** La misma familia que el clasificador (clasificar-cfdi.ts): «Software». */
const CLAVE_INTANGIBLE_PREFIJOS = ["4323"];

/**
 * El nombre NO alcanza para reclasificar solo, y el simulacro lo demostró: las
 * descripciones traen la ficha técnica completa, así que «LAPTOP TOSHIBA … /
 * Sistema operativo: Windows» y hasta un tomógrafo Siemens pegaban con
 * «software». Un equipo reclasificado a intangible se amortiza al 15 % en la
 * cuenta equivocada — peor que dejarlo como está.
 *
 * Así que el nombre sólo SUGIERE: esos salen en una lista aparte, para que los
 * mire una persona y los corrija con el selector de tipo.
 */
const PALABRAS = /licenc|suscripci|antivirus|\boffice\b|saas|software/i;

/** Si el nombre dice que es una cosa física, no es un intangible. */
const PALABRAS_HARDWARE = /laptop|notebook|servidor|computadora|\baio\b|pantalla|monitor|impresora|procesador|tom[oó]grafo|equipo|enrolador|esc[aá]ner|tel[eé]fono|celular|tablet|disco|memoria|teclado|mouse/i;

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const empresa = process.argv.find((a) => a.startsWith("--empresa="))?.split("=")[1];

  const activos = await prisma.activoFijo.findMany({
    where: {
      autoCreado: true,
      tipo: { not: "intangible" },
      ...(empresa ? { companyId: empresa } : {}),
    },
    select: {
      id: true, companyId: true, descripcion: true, tipo: true, moi: true, tasaAnual: true, invoiceId: true,
    },
  });

  const empresas = new Map(
    (await prisma.company.findMany({
      where: { id: { in: [...new Set(activos.map((a) => a.companyId))] } },
      select: { id: true, razonSocial: true },
    })).map((c) => [c.id, c.razonSocial]),
  );

  const claves = new Map<string, string[]>();
  const conFactura = activos.map((a) => a.invoiceId).filter((x): x is string => !!x);
  if (conFactura.length > 0) {
    const items = await prisma.invoiceItem.findMany({
      where: { invoiceId: { in: conFactura } },
      select: { invoiceId: true, claveProdServ: true },
    });
    for (const it of items) {
      const lista = claves.get(it.invoiceId) ?? [];
      lista.push(it.claveProdServ);
      claves.set(it.invoiceId, lista);
    }
  }

  const tasa = TASA_DEPRECIACION.intangible.tasa;
  const etiqueta = (a: { companyId: string; descripcion: string; tipo: string; tasaAnual: unknown }) =>
    `  ${(empresas.get(a.companyId) ?? a.companyId).slice(0, 28).padEnd(28)} ${a.descripcion.replace(/\s+/g, " ").slice(0, 46).padEnd(46)} ` +
    `${a.tipo} ${(Number(a.tasaAnual ?? 0) * 100).toFixed(0)}%`;

  const porClaveDe = (a: { invoiceId: string | null }) =>
    (claves.get(a.invoiceId ?? "") ?? []).some((c) => CLAVE_INTANGIBLE_PREFIJOS.some((p) => c?.startsWith(p)));

  // EVIDENCIA FUERTE: la clave del CFDI dice «Software» y el nombre no dice que
  // sea una cosa física. Sólo estos se tocan.
  const candidatos = activos.filter((a) => porClaveDe(a) && !PALABRAS_HARDWARE.test(a.descripcion));
  // SOSPECHOSOS: el nombre suena a licencia o suscripción, pero el nombre solo
  // no basta. Se listan para que los corrija una persona con el selector.
  const sospechosos = activos.filter(
    (a) => !candidatos.includes(a) && (PALABRAS.test(a.descripcion) || (porClaveDe(a) && PALABRAS_HARDWARE.test(a.descripcion))),
  );

  console.log(`${activos.length} activos auto-creados revisados\n`);
  console.log(`${candidatos.length} con evidencia fuerte (la clave del CFDI dice Software):`);
  for (const a of candidatos) console.log(`${etiqueta(a)} → intangible ${(tasa * 100).toFixed(0)}%`);

  if (sospechosos.length > 0) {
    console.log(`\n${sospechosos.length} para MIRAR a mano — no se tocan:`);
    for (const a of sospechosos) {
      console.log(`${etiqueta(a)}   (${porClaveDe(a) ? "clave dice software pero el nombre dice hardware" : "sólo el nombre lo sugiere"})`);
    }
  }

  if (!aplicar) {
    console.log(`\nSimulacro. Para escribir: --aplicar`);
    return;
  }
  for (const a of candidatos) {
    await prisma.activoFijo.update({
      where: { id: a.id },
      // autoCreado se queda: sigue necesitando ojo humano (perpetua 5 %,
      // diferido 15 %, o suscripción que ni es activo).
      data: { tipo: "intangible", tasaAnual: tasa },
    });
  }
  console.log(`\n${candidatos.length} activos reclasificados. La depreciación del mes cambia al re-contabilizar.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
