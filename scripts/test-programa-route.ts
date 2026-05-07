import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const id = "cmokfbxgo0001nw1dxm8dtfjb"; // Platino 2br
  const proyecto = await prisma.proyecto.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      codigo: true,
      fechaInicio: true,
      weekCount: true,
    },
  });
  console.log("Proyecto:", proyecto);

  if (!proyecto) {
    console.log("→ would 404 here");
    return;
  }

  const template = await prisma.estimacionTemplate.findUnique({
    where: { proyectoId: id },
    include: {
      partidas: { include: { presupuestoPartida: { select: { importe: true } } } },
      curvas: true,
      calendarioCierre: true,
    },
  });

  if (!template) {
    console.log("→ would 422 'no plantilla'");
    return;
  }

  console.log(
    `Template: ${template._count?.partidas ?? template.partidas.length} partidas, ${template.curvas.length} curvas, ${template.calendarioCierre.length} calendario`
  );

  const importeByCap = new Map();
  for (const tp of template.partidas) {
    importeByCap.set(
      tp.capituloCode,
      (importeByCap.get(tp.capituloCode) ?? 0) + (tp.presupuestoPartida.importe ?? 0)
    );
  }
  console.log(`Capítulos:`, [...importeByCap.entries()].slice(0, 5));

  console.log("→ would return 200 with full payload");
}

main().finally(() => prisma.$disconnect());
