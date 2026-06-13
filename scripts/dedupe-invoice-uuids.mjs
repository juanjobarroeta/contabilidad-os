/**
 * De-duplica facturas (Invoice) que quedaron repetidas por DIFERENCIA DE CAJA
 * en el UUID (folio fiscal): la copia timbrada por el PAC se guardó en minúsculas
 * y la descargada del SAT en mayúsculas, así que el mismo CFDI aparece dos veces.
 * Efecto: ingresos/IVA contados doble y cancelaciones que sólo empatan una copia.
 *
 * Qué hace, por EMPRESA y agrupando por upper(uuid):
 *   1. Elige un sobreviviente por grupo (más InvoiceTax → con rawXml → más viejo).
 *   2. Estatus canónico del grupo: CANCELLED si alguna copia está cancelada
 *      (el SAT manda), si no STAMPED. Copia canceladaAt/motivo/sustituye al
 *      sobreviviente si la cancelada era otra.
 *   3. Re-apunta hijos que se perderían al borrar (BankTransaction.invoiceId,
 *      ActivoFijo.invoiceId) del condenado → sobreviviente.
 *   4. Borra las copias sobrantes (InvoiceItem/InvoiceTax caen por cascade).
 *
 * NO reescribe la caja del uuid: el código ya empata case-insensitive y el uuid
 * es @unique GLOBAL (pasar a mayúsculas podría chocar con copias intercompañía).
 *
 * Seguro por defecto: DRY-RUN (no escribe). Pasa --apply para ejecutar.
 * Cada grupo se procesa en su propia transacción.
 *
 * Uso:
 *   set -a; . ./.env.local; set +a
 *   node scripts/dedupe-invoice-uuids.mjs                 # dry-run, todas las empresas
 *   node scripts/dedupe-invoice-uuids.mjs <companyId>     # dry-run, una empresa
 *   node scripts/dedupe-invoice-uuids.mjs <companyId> --apply   # ejecuta
 *   node scripts/dedupe-invoice-uuids.mjs --apply         # ejecuta en todas
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const companyIdArg = args.find((a) => !a.startsWith("--")) ?? null;

const STATUS_RANK = { CANCELLED: 3, STAMPED: 2, DRAFT: 1 };

function pickSurvivor(rows) {
  // más taxes → con rawXml → más antiguo. Determinista.
  return [...rows].sort((a, b) => {
    if (b.taxesCount !== a.taxesCount) return b.taxesCount - a.taxesCount;
    const ar = a.rawXml ? 1 : 0, br = b.rawXml ? 1 : 0;
    if (br !== ar) return br - ar;
    return a.createdAt - b.createdAt;
  })[0];
}

function canonicalStatus(rows) {
  // CANCELLED si cualquiera lo está; si no, el más "avanzado".
  return rows.reduce(
    (acc, r) => ((STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[acc] ?? 0) ? r.status : acc),
    "DRAFT"
  );
}

async function main() {
  console.log(`\n═══ De-dup de UUIDs de facturas — ${APPLY ? "APLICAR" : "DRY-RUN"} ═══\n`);

  const companies = await prisma.company.findMany({
    where: { ...(companyIdArg ? { id: companyIdArg } : {}) },
    select: { id: true, razonSocial: true, rfc: true },
  });

  let totalGroups = 0, totalDeleted = 0, totalRepointed = 0, totalStatusFixed = 0;

  for (const company of companies) {
    // Grupos de uuid (insensible a caja) con más de una fila en ESTA empresa.
    const dupGroups = await prisma.$queryRaw`
      SELECT upper(uuid) AS norm, count(*)::int AS n
      FROM "Invoice"
      WHERE "companyId" = ${company.id} AND uuid IS NOT NULL
      GROUP BY upper(uuid)
      HAVING count(*) > 1
    `;
    if (dupGroups.length === 0) continue;

    console.log(`\n▸ ${company.razonSocial} (${company.rfc}) — ${dupGroups.length} folios duplicados`);

    for (const g of dupGroups) {
      const raw = await prisma.invoice.findMany({
        where: { companyId: company.id, uuid: { equals: g.norm, mode: "insensitive" } },
        select: { id: true, uuid: true, status: true, rawXml: true, createdAt: true,
                  canceladaAt: true, cancelMotivo: true, cancelSustituyeUuid: true,
                  _count: { select: { taxes: true } } },
      });
      if (raw.length < 2) continue;
      const rows = raw.map((r) => ({ ...r, taxesCount: r._count.taxes, createdAt: r.createdAt.getTime() }));

      const survivor = pickSurvivor(rows);
      const doomed = rows.filter((r) => r.id !== survivor.id);
      const status = canonicalStatus(rows);
      const cancelledSrc = rows.find((r) => r.status === "CANCELLED");

      totalGroups++;
      totalDeleted += doomed.length;

      console.log(
        `  · ${g.norm}  keep ${survivor.uuid} [${survivor.status}→${status}, taxes:${survivor.taxesCount}]` +
        `  drop ${doomed.map((d) => `${d.uuid}[${d.status}]`).join(", ")}`
      );

      if (!APPLY) continue;

      const doomedIds = doomed.map((d) => d.id);
      await prisma.$transaction(async (tx) => {
        // Re-apuntar hijos que se perderían (FK quedaría en NULL al borrar).
        const rb = await tx.bankTransaction.updateMany({
          where: { invoiceId: { in: doomedIds } }, data: { invoiceId: survivor.id },
        });
        const ra = await tx.activoFijo.updateMany({
          where: { invoiceId: { in: doomedIds } }, data: { invoiceId: survivor.id },
        });
        totalRepointed += rb.count + ra.count;

        // Estatus canónico (+ datos de cancelación si venían de otra copia).
        if (survivor.status !== status || (status === "CANCELLED" && !survivor.canceladaAt)) {
          await tx.invoice.update({
            where: { id: survivor.id },
            data: {
              status,
              ...(status === "CANCELLED" && cancelledSrc
                ? {
                    canceladaAt: survivor.canceladaAt ?? cancelledSrc.canceladaAt ?? new Date(),
                    cancelMotivo: survivor.cancelMotivo ?? cancelledSrc.cancelMotivo,
                    cancelSustituyeUuid: survivor.cancelSustituyeUuid ?? cancelledSrc.cancelSustituyeUuid,
                  }
                : {}),
            },
          });
          totalStatusFixed++;
        }

        // Borrar copias sobrantes (items/taxes caen por cascade).
        await tx.invoice.deleteMany({ where: { id: { in: doomedIds } } });
      });
    }
  }

  console.log("\n─── Resumen ────────────────────────");
  console.log(`  Folios duplicados:     ${totalGroups}`);
  console.log(`  Copias ${APPLY ? "borradas" : "a borrar"}:      ${totalDeleted}`);
  console.log(`  Hijos re-apuntados:    ${totalRepointed}`);
  console.log(`  Estatus corregidos:    ${totalStatusFixed}`);
  if (!APPLY) console.log(`\n  (DRY-RUN — nada se escribió. Corre con --apply para ejecutar.)`);
  console.log();
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
