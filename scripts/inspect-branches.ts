import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const proyecto = await p.proyecto.findFirst({
    where: { codigo: "TP01" },
    include: { presupuestos: { take: 1 } },
  });
  const presupuestoId = proyecto!.presupuestos[0].id;

  const branches = await p.presupuestoPartida.findMany({
    where: { presupuestoId, esRollup: true },
    select: { codigo: true, nivel: true, partida: true, parentPartidaId: true, id: true },
    orderBy: [{ nivel: "asc" }, { orden: "asc" }],
  });

  const byNivel = new Map<number, number>();
  for (const b of branches) byNivel.set(b.nivel, (byNivel.get(b.nivel) ?? 0) + 1);
  console.log("Branches by nivel:", Object.fromEntries(byNivel));

  const d1 = branches.filter((b) => b.nivel === 1);
  console.log(`\nDepth 1 (${d1.length}):`);
  for (const b of d1.slice(0, 35)) {
    console.log(`  codigo="${b.codigo}" nivel=${b.nivel} partida="${b.partida?.slice(0, 40)}"`);
  }

  // Check capítulo 18's children
  const cap18 = d1.find((b) => b.codigo === "18" || b.codigo === "18.0");
  if (cap18) {
    const c2 = branches.filter((b) => b.parentPartidaId === cap18.id);
    console.log(`\nDirect children of cap 18 (${cap18.codigo}, id=${cap18.id}):`);
    for (const c of c2) console.log(`  codigo="${c.codigo}" nivel=${c.nivel} partida="${c.partida?.slice(0,40)}"`);
  }
}

main().finally(() => p.$disconnect());
