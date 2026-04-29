/**
 * Verifies the bootstrap logic on Decolsa's already-imported Torres Platino
 * presupuesto. Runs inside a transaction that ROLLS BACK so it's safe to
 * run repeatedly without polluting the DB.
 */
import { PrismaClient } from "@prisma/client";
import { bootstrapEstimacionTemplate } from "../src/lib/construccion/estimacion-template-bootstrap";

const prisma = new PrismaClient();

async function main() {
  const proyecto = await prisma.proyecto.findFirst({
    where: { codigo: "TP01", company: { rfc: "DIN1604261F8" } },
    include: { presupuestos: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  if (!proyecto || proyecto.presupuestos.length === 0) {
    console.log("Decolsa Torres Platino not found or no presupuesto");
    return;
  }
  const presupuesto = proyecto.presupuestos[0];
  console.log(`Proyecto: ${proyecto.codigo} — ${proyecto.nombre}`);
  console.log(`Presupuesto: ${presupuesto.id}, monto $${presupuesto.montoTotal.toFixed(2)}`);

  // Wipe any existing template to test clean bootstrap
  await prisma.estimacionTemplate.deleteMany({ where: { proyectoId: proyecto.id } });

  await prisma.$transaction(async (tx) => {
    // bigger timeout for the smoke test
    void tx;
    const r = await bootstrapEstimacionTemplate(tx, {
      proyectoId: proyecto.id,
      companyId: proyecto.companyId,
      presupuestoId: presupuesto.id,
      weekCount: 48,
    });
    console.log(`\nBootstrap result:`);
    console.log(`  templateId: ${r.templateId}`);
    console.log(`  partidas:   ${r.partidasCreated}`);
    console.log(`  curvas:     ${r.curvasCreated}`);

    // List the rows to validate the rule
    const partidas = await tx.estimacionTemplatePartida.findMany({
      where: { templateId: r.templateId },
      include: { presupuestoPartida: { select: { codigo: true, nivel: true, partida: true } } },
      orderBy: { orden: "asc" },
    });
    console.log(`\nFirst 10 template partidas:`);
    for (const p of partidas.slice(0, 10)) {
      const pp = p.presupuestoPartida;
      console.log(`  ${p.orden + 1}. cap=${p.capituloCode}  partida=${pp.codigo} (nivel ${pp.nivel}) — ${p.descripcion.slice(0, 50)}`);
    }
    console.log(`  ...`);

    // Show the breakdown by capítulo
    const byCap = new Map<string, number>();
    for (const p of partidas) byCap.set(p.capituloCode, (byCap.get(p.capituloCode) ?? 0) + 1);
    console.log(`\nRows per capítulo:`);
    for (const [cap, count] of [...byCap.entries()].sort((a, b) => +a[0] - +b[0])) {
      console.log(`  cap ${cap}: ${count} row(s)${count > 1 ? " (OPEN)" : " (rolled)"}`);
    }

    const curvas = await tx.estimacionCurvaCapitulo.findMany({
      where: { templateId: r.templateId },
      orderBy: { capituloCode: "asc" },
    });
    const matched = curvas.filter((c) => {
      const arr = c.pesoPctSemanal as number[];
      return Array.isArray(arr) && arr.some((w) => w > 0);
    });
    console.log(`\nCurvas: ${curvas.length} total, ${matched.length} with default values, ${curvas.length - matched.length} empty (no template default)`);

    // Roll back so the smoke test doesn't actually persist
    throw new Error("ROLLBACK_INTENTIONAL");
  }, { timeout: 60_000, maxWait: 5_000 }).catch((e) => {
    if (e.message === "ROLLBACK_INTENTIONAL") {
      console.log("\n✓ Transaction rolled back — DB unchanged.");
    } else throw e;
  });
}

main().finally(() => prisma.$disconnect());
