import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const proy = await p.proyecto.findFirst({
    where: { codigo: "TP01" },
    select: { id: true, codigo: true, nombre: true, companyId: true, fechaInicio: true, weekCount: true },
  });
  console.log(proy);
  if (proy) {
    const tpl = await p.estimacionTemplate.findUnique({
      where: { proyectoId: proy.id },
      include: { curvas: { take: 1 }, calendarioCierre: { take: 1 } },
    });
    console.log("Template exists:", !!tpl);
    console.log("Curvas:", await p.estimacionCurvaCapitulo.count({ where: { templateId: tpl?.id } }));
    console.log("Calendario:", await p.calendarioCierreCapitulo.count({ where: { templateId: tpl?.id } }));
  }
}

main().finally(() => p.$disconnect());
