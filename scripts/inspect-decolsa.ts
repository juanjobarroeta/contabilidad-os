import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const company = await p.company.findFirst({ where: { rfc: "DIN1604261F8" }, select: { id: true } });
  if (!company) { console.log("Decolsa not found"); return; }

  const proyectos = await p.proyecto.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      codigo: true,
      nombre: true,
      fechaInicio: true,
      weekCount: true,
      viviendasObjetivo: true,
      _count: { select: { estimaciones: true } },
    },
  });

  for (const pr of proyectos) {
    const tpl = await p.estimacionTemplate.findUnique({
      where: { proyectoId: pr.id },
      select: {
        id: true,
        _count: { select: { partidas: true, curvas: true, calendarioCierre: true } },
      },
    });
    console.log(`\n${pr.codigo} — ${pr.nombre} (id=${pr.id})`);
    console.log(`  fechaInicio: ${pr.fechaInicio}, weekCount: ${pr.weekCount}, viviendas: ${pr.viviendasObjetivo}`);
    console.log(`  estimaciones: ${pr._count.estimaciones}`);
    if (tpl) {
      console.log(`  template: id=${tpl.id} partidas=${tpl._count.partidas} curvas=${tpl._count.curvas} calendario=${tpl._count.calendarioCierre}`);
    } else {
      console.log(`  template: NONE`);
    }
  }
}

main().finally(() => p.$disconnect());
