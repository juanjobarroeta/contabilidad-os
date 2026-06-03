/**
 * Backfill firm REP (complemento de pago) data onto existing PagoDoctoRelacionado
 * rows: FechaPago, and the per-docto IVA breakdown (BaseDR / ImporteDR) for
 * complemento 2.0. Re-parses each stored rawXml — no SAT round-trip.
 *
 * REPs imported before these columns existed have them null. The cash-basis IVA
 * engine attributes PPD IVA by FechaPago and reads ivaTrasladado, so this must
 * run once after deploying the schema change. Idempotent: safe to re-run.
 *
 * Legacy complemento 1.0 (CFDI 3.3) carries no IVA breakdown — those rows get
 * fechaPago + ivaDerivado=true (the engine prorates the parent invoice).
 *
 * Usage (point DATABASE_URL at the target DB):
 *
 *   DATABASE_URL=<target db url> \
 *   DRY_RUN=1 \                        # preview without writing (optional)
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-rep-iva.ts
 */
import { PrismaClient } from "@prisma/client";
import { parseCfdiXml } from "../src/lib/sat-fiel";

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const prisma = new PrismaClient();
  const pagos = await prisma.invoice.findMany({
    where: { tipo: "PAGO", rawXml: { not: null } },
    select: { id: true, rawXml: true },
  });

  let updated = 0;
  let unmatched = 0;
  let firm = 0;
  let derived = 0;

  for (const inv of pagos) {
    const cfdi = parseCfdiXml(inv.rawXml!);
    for (const d of cfdi.doctosRelacionados) {
      if (d.ivaDerivado) derived++;
      else firm++;
      if (DRY_RUN) continue;
      const res = await prisma.pagoDoctoRelacionado.updateMany({
        where: { pagoInvoiceId: inv.id, parentUuid: d.uuid },
        data: {
          fechaPago: d.fechaPago ? new Date(d.fechaPago) : null,
          baseTraslado: d.baseTraslado,
          ivaTrasladado: d.ivaTrasladado,
          ivaDerivado: d.ivaDerivado,
        },
      });
      if (res.count > 0) updated += res.count;
      else unmatched++;
    }
  }

  console.log(
    `[backfill-rep-iva]${DRY_RUN ? " (dry run)" : ""} ` +
      `REPs parsed: ${pagos.length}, doctos: ${firm + derived} ` +
      `(firm 2.0: ${firm}, derived 1.0/sin-desglose: ${derived}), ` +
      `rows updated: ${updated}, unmatched: ${unmatched}`
  );

  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
