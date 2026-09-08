// Vuelve a correr la conciliación automática de una empresa y reporta qué se
// movió, con el detalle de nómina.
//
// Existe porque los arreglos al motor (empate de nombres truncados o con
// erratas) sólo actúan cuando algo vuelve a puntuar: los movimientos que
// quedaron sin conciliar con el motor viejo se quedan así para siempre si
// nadie los vuelve a pasar. Es idempotente —conciliar lo ya conciliado no
// hace nada— así que se puede correr las veces que haga falta.
//
// Uso: npx tsx scripts/reconciliar-nomina-pendiente.ts <companyId> [--aplicar]
// Sin --aplicar sólo dice cuántos hay pendientes y no toca nada.
import { prisma } from "../src/lib/prisma";
import { autoConciliarEmpresa } from "../src/lib/bancos/auto-conciliar";

const fmt = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

async function pendientes(companyId: string) {
  return prisma.bankTransaction.findMany({
    where: { companyId, status: "UNMATCHED" },
    select: { id: true, fecha: true, monto: true, descripcion: true, contraparteNombre: true },
    orderBy: { fecha: "asc" },
  });
}

async function main() {
  const companyId = process.argv[2];
  const aplicar = process.argv.includes("--aplicar");
  if (!companyId) {
    console.error("Uso: npx tsx scripts/reconciliar-nomina-pendiente.ts <companyId> [--aplicar]");
    process.exit(1);
  }

  const antes = await pendientes(companyId);
  console.log(`Sin conciliar antes: ${antes.length}`);
  if (!aplicar) {
    console.log("(simulación — nada se tocó; agrega --aplicar para correr)");
    for (const t of antes.slice(0, 20)) {
      console.log(`  ${t.fecha.toISOString().slice(0, 10)}  ${fmt(Number(t.monto)).padStart(14)}  ${t.contraparteNombre ?? t.descripcion.slice(0, 40)}`);
    }
    await prisma.$disconnect();
    return;
  }

  const r = await autoConciliarEmpresa(companyId);
  const despues = await pendientes(companyId);
  const idsDespues = new Set(despues.map((t) => t.id));
  const resueltos = antes.filter((t) => !idsDespues.has(t.id));

  console.log(`\nConciliados en esta corrida: ${resueltos.length}   (sin conciliar ahora: ${despues.length})`);
  for (const t of resueltos) {
    console.log(`  ✓ ${t.fecha.toISOString().slice(0, 10)}  ${fmt(Number(t.monto)).padStart(14)}  ${t.contraparteNombre ?? t.descripcion.slice(0, 40)}`);
  }
  console.log(`\nresumen del motor: ${JSON.stringify(r)}`);
  await prisma.$disconnect();
}

main();
