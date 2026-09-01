// Backfill: recibos de nómina (Invoice tipo NOMINA) sin contraparte.
//
// emit-nomina.ts creaba el Invoice sin contraparteNombre/contraparteRfc — la
// identidad del empleado sólo quedaba en `notas` y la UI mostraba "—". El
// emisor ya se corrigió; esto repara lo timbrado antes. Identidad por dos
// vías, en orden de certeza:
//   1. PayrollItem.cfdiUuid === Invoice.uuid → Employee (nombre + RFC).
//   2. `notas` "Nómina {nombre} · ..." → nombre; RFC sólo si UN empleado del
//      padrón empata por nombre (dos homónimos = sólo nombre).
//
// Uso: npx tsx scripts/repair-nomina-contraparte.ts [--apply]
//      (sin --apply es dry-run: reporta y no escribe)
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");

const nombreCompleto = (e: { nombre: string; apellidoPaterno: string; apellidoMaterno: string | null }) =>
  [e.nombre, e.apellidoPaterno, e.apellidoMaterno].filter(Boolean).join(" ").trim();

async function main() {
  const rotos = await prisma.invoice.findMany({
    where: { tipo: "NOMINA", OR: [{ contraparteNombre: null }, { contraparteRfc: null }] },
    select: { id: true, companyId: true, uuid: true, notas: true, total: true, fecha: true },
  });
  console.log(`${rotos.length} recibo(s) de nómina sin contraparte`);

  let porUuid = 0, porNotas = 0, sinIdentidad = 0;
  for (const inv of rotos) {
    let nombre: string | null = null;
    let rfc: string | null = null;

    if (inv.uuid) {
      const item = await prisma.payrollItem.findFirst({
        where: { cfdiUuid: { equals: inv.uuid, mode: "insensitive" } },
        select: { employee: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true, companyId: true } } },
      });
      if (item?.employee && item.employee.companyId === inv.companyId) {
        nombre = nombreCompleto(item.employee);
        rfc = item.employee.rfc;
        porUuid++;
      }
    }
    if (!nombre && inv.notas?.startsWith("Nómina ")) {
      const crudo = inv.notas.slice("Nómina ".length).split("·")[0]?.trim();
      if (crudo) {
        nombre = crudo;
        const empleados = await prisma.employee.findMany({
          where: { companyId: inv.companyId },
          select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true },
        });
        const norm = (s: string) => s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
        const empatan = empleados.filter((e) => norm(nombreCompleto(e)).includes(norm(crudo)) || norm(crudo).includes(norm(nombreCompleto(e))));
        if (empatan.length === 1) rfc = empatan[0].rfc;
        porNotas++;
      }
    }
    if (!nombre) { sinIdentidad++; continue; }

    console.log(`  ${inv.fecha.toISOString().slice(0, 10)} $${inv.total} → ${nombre}${rfc ? ` (${rfc})` : " (sin RFC)"}${APPLY ? "" : " [dry-run]"}`);
    if (APPLY) {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { contraparteNombre: nombre, ...(rfc ? { contraparteRfc: rfc } : {}) },
      });
    }
  }
  console.log(`por UUID: ${porUuid} · por notas: ${porNotas} · sin identidad: ${sinIdentidad}${APPLY ? " · APLICADO" : " · dry-run (usa --apply)"}`);
  await prisma.$disconnect();
}
main();
