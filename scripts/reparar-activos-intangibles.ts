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

/** Las mismas familias que el clasificador (clasificar-cfdi.ts). */
const CLAVE_INTANGIBLE_PREFIJOS = ["4323", "81112"];
/** Cuando no hay renglones, el nombre del activo es la última pista. */
const PALABRAS = /licenc|software|suscripci|sistema operativo|antivirus|office\b|saas/i;

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
  const candidatos = activos.filter((a) => {
    const porClave = (claves.get(a.invoiceId ?? "") ?? []).some((c) =>
      CLAVE_INTANGIBLE_PREFIJOS.some((p) => c?.startsWith(p)),
    );
    return porClave || PALABRAS.test(a.descripcion);
  });

  console.log(`${activos.length} activos auto-creados revisados · ${candidatos.length} parecen intangibles\n`);
  for (const a of candidatos) {
    const porClave = (claves.get(a.invoiceId ?? "") ?? []).some((c) =>
      CLAVE_INTANGIBLE_PREFIJOS.some((p) => c?.startsWith(p)),
    );
    console.log(
      `  ${(empresas.get(a.companyId) ?? a.companyId).slice(0, 28).padEnd(28)} ${a.descripcion.slice(0, 44).padEnd(44)} ` +
        `${a.tipo} ${(Number(a.tasaAnual ?? 0) * 100).toFixed(0)}% → intangible ${(tasa * 100).toFixed(0)}%  ` +
        `(${porClave ? "clave de producto" : "por el nombre"})`,
    );
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
