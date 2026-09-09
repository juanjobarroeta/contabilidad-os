// Siembra el directorio CLABE → contraparte con lo que ya sabemos.
//
// Los pares se venían deduciendo en vivo (`clabesConocidasPorRfc`) escaneando
// movimientos conciliados. Ese conocimiento ya existe: aquí se materializa para
// que valga desde el primer movimiento y se pueda ver y corregir.
//
// Uso: npx tsx scripts/backfill-cuentas-contraparte.ts [--aplicar]
import { prisma } from "../src/lib/prisma";

async function main() {
  const aplicar = process.argv.includes("--aplicar");

  // Movimientos que ya traen CLABE y RFC juntos: la evidencia mínima de que
  // esa cuenta es de esa contraparte.
  const movs = await prisma.bankTransaction.findMany({
    where: { contraparteClabe: { not: null }, contraparteRfc: { not: null } },
    select: {
      companyId: true, contraparteClabe: true, contraparteRfc: true,
      contraparteNombre: true, contraparteBanco: true, cepAt: true,
    },
  });

  // Una CLABE es de UNA contraparte. Si dos RFC distintos aparecen con la misma
  // CLABE hay un error de datos: no se siembra, se reporta.
  const porClave = new Map<string, { rfcs: Set<string>; nombre?: string; banco?: string; origen: string }>();
  for (const m of movs) {
    const clabe = (m.contraparteClabe ?? "").replace(/\D/g, "");
    if (clabe.length !== 18 || !m.contraparteRfc) continue;
    const k = `${m.companyId}|${clabe}`;
    const e = porClave.get(k) ?? { rfcs: new Set<string>(), origen: "CONCILIACION" };
    // Sin espacios: Banxico parte los campos en bloques de ancho fijo y a
    // veces mete un espacio A MEDIO RFC («GEP850101 1S6»). Ese RFC no empata
    // con ninguna factura, así que se normaliza aquí y se reporta abajo.
    e.rfcs.add(m.contraparteRfc.replace(/\s+/g, "").toUpperCase());
    e.nombre ??= m.contraparteNombre ?? undefined;
    e.banco ??= m.contraparteBanco ?? undefined;
    if (m.cepAt) e.origen = "CEP";
    porClave.set(k, e);
  }

  let sembrados = 0, conflictos = 0;
  for (const [k, e] of porClave) {
    if (e.rfcs.size > 1) {
      conflictos++;
      console.log(`  ⚠ ${k.split("|")[1]} aparece con ${e.rfcs.size} RFC distintos: ${[...e.rfcs].join(", ")} — no se siembra`);
      continue;
    }
    sembrados++;
    if (!aplicar) continue;
    const [companyId, clabe] = k.split("|");
    await prisma.cuentaContraparte.upsert({
      where: { companyId_clabe: { companyId, clabe } },
      update: {},
      create: { companyId, clabe, rfc: [...e.rfcs][0], nombre: e.nombre, banco: e.banco, origen: e.origen },
    });
  }

  console.log(`\nmovimientos con CLABE + RFC: ${movs.length}`);
  console.log(`cuentas ${aplicar ? "sembradas" : "que se sembrarían"}: ${sembrados}`);
  console.log(`conflictos (misma CLABE, varios RFC): ${conflictos}`);
  if (!aplicar) console.log("(simulación — agrega --aplicar)");
  await prisma.$disconnect();
}
main();
