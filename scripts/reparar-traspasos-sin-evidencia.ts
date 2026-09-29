/**
 * Repara los movimientos etiquetados como TRASPASO ENTRE CUENTAS PROPIAS sin
 * evidencia de que lo sean (lib/bancos/traspaso-evidencia). Por default SÓLO
 * LECTURA: lista lo que revertiría. Con --apply los regresa a UNMATCHED (sin
 * etiqueta) para que la mesa los resuelva, y deja una fila en DecisionMotor por
 * movimiento con la razón.
 *
 * Qué NO se puede distinguir: antes de este cambio nada registraba si la
 * etiqueta la puso una persona, una regla, el import o el Excel de caja. Por
 * eso el listado incluye TODOS los que no tienen evidencia, salvo los que ya
 * tienen una decisión de una persona en el rastro (DecisionMotor actor
 * «usuario»). Revise el listado antes de --apply; --excluir id1,id2 deja fuera
 * los que una persona haya marcado a sabiendas. Los periodos CERRADOS no se
 * tocan.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/reparar-traspasos-sin-evidencia.ts --company <RFC> [--desde 2026-01] [--excluir id1,id2] [--apply]
 */
import { prisma } from "../src/lib/prisma";
import { evidenciaTraspaso, motivoSinEvidencia } from "../src/lib/bancos/traspaso-evidencia";
import { contextoTraspaso } from "../src/lib/bancos/traspaso-evidencia-db";
import { filaDeDecision } from "../src/lib/decisiones";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rfc = arg("company");
  const desde = arg("desde") ?? "2000-01";
  const excluir = new Set((arg("excluir") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const aplicar = process.argv.includes("--apply");
  if (!rfc || !/^\d{4}-\d{2}$/.test(desde)) {
    console.error("Uso: npx tsx scripts/reparar-traspasos-sin-evidencia.ts --company <RFC> [--desde AAAA-MM] [--excluir id1,id2] [--apply]");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const [y, m] = desde.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));

  const movs = (
    await prisma.bankTransaction.findMany({
      where: { companyId: company.id, status: "IGNORED", notes: { in: ["INTERNAL_TRANSFER", "TRASPASO"] }, fecha: { gte: from } },
      select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, contraparteNombre: true, contraparteRfc: true, contraparteClabe: true, notes: true },
      orderBy: { fecha: "asc" },
    })
  ).map((t) => ({ ...t, monto: Number(t.monto) }));
  const ctx = await contextoTraspaso(company.id, movs.map((t) => t.fecha));
  if (!ctx) throw new Error("No se pudo cargar el contexto de la empresa");

  const deUsuario = new Set(
    (
      await prisma.decisionMotor.findMany({
        where: { companyId: company.id, entidad: "BankTransaction", entidadId: { in: movs.map((t) => t.id) }, actor: "usuario" },
        select: { entidadId: true },
      })
    ).map((d) => d.entidadId),
  );
  const cerrados = new Set(
    (await prisma.accountingPeriod.findMany({ where: { companyId: company.id, status: "CLOSED" }, select: { year: true, month: true } })).map(
      (p) => `${p.year}-${p.month}`,
    ),
  );

  const revertir: { t: (typeof movs)[number]; motivo: string }[] = [];
  let conEvidencia = 0, porUsuario = 0, excluidos = 0, enCerrado = 0;
  for (const t of movs) {
    const ev = evidenciaTraspaso(t, ctx);
    if (ev.tiene) { conEvidencia++; continue; }
    if (deUsuario.has(t.id)) { porUsuario++; continue; }
    if (excluir.has(t.id)) { excluidos++; continue; }
    if (cerrados.has(`${t.fecha.getUTCFullYear()}-${t.fecha.getUTCMonth() + 1}`)) { enCerrado++; continue; }
    revertir.push({ t, motivo: motivoSinEvidencia(ev) });
  }

  console.log(`${company.razonSocial} (${rfc}) — traspasos propios desde ${desde}: ${movs.length}`);
  console.log(`  con evidencia: ${conEvidencia} · decisión de una persona: ${porUsuario} · excluidos: ${excluidos} · en periodo cerrado: ${enCerrado}`);
  console.log(`  SIN evidencia, a revertir: ${revertir.length} por ${fmt(revertir.reduce((s, r) => s + Math.abs(r.t.monto), 0))}`);
  console.log("  (No se distingue si la etiqueta vieja la puso una persona o el sistema: revise antes de --apply.)\n");
  for (const { t, motivo } of revertir) {
    console.log(`  ${t.id}  ${t.fecha.toISOString().slice(0, 10)} ${fmt(t.monto).padStart(12)}  ${t.descripcion.replace(/\s+/g, " ").slice(0, 70)}\n      ${motivo}`);
  }

  if (!aplicar) {
    console.log("\nSólo lectura. Agregue --apply para revertir.");
    await prisma.$disconnect();
    return;
  }
  for (const { t, motivo } of revertir) {
    await prisma.$transaction([
      prisma.bankTransaction.update({ where: { id: t.id }, data: { status: "UNMATCHED", notes: null } }),
      prisma.decisionMotor.create({
        data: filaDeDecision({
          companyId: company.id,
          entidad: "BankTransaction",
          entidadId: t.id,
          motor: "reparar-traspasos",
          actor: "motor",
          accion: "rechazo",
          resultado: { etiquetaPrevia: t.notes, status: "UNMATCHED" },
          razones: [{ regla: "traspaso.sin-evidencia", detalle: `estaba marcado como traspaso entre cuentas propias; ${motivo}` }],
        }),
      }),
    ]);
  }
  console.log(`\nRevertidos: ${revertir.length}. Quedan pendientes en la mesa.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
