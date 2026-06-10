// ─────────────────────────────────────────────────────────────────────────────
// Backfill: fix Invoice.tipo for rows mis-classified by the old import logic.
//
// The bug: CFDI import trusted TipoDeComprobante (I/E) over emisor-vs-receptor.
// A supplier's sales invoice TO us is type "I", so received purchase invoices
// were stored as INGRESO (income) instead of EGRESO (expense). This re-derives
// the correct direction from the authentic rawXml: emisor RFC === company RFC
// ⇒ INGRESO, else EGRESO. Only touches INGRESO/EGRESO rows that carry rawXml;
// NOMINA / PAGO / TRASLADO are left untouched.
//
//   Dry run (default):  DATABASE_URL=... node scripts/fix-invoice-direction.mjs
//   Apply changes:      DATABASE_URL=... node scripts/fix-invoice-direction.mjs --apply
// ─────────────────────────────────────────────────────────────────────────────
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

// First Rfc="..." inside an Emisor element. CFDI lists Emisor before Receptor,
// and both 3.3 and 4.0 use the cfdi: namespace prefix.
function emisorRfc(xml) {
  const m = xml.match(/<[a-zA-Z:]*Emisor\b[^>]*\bRfc="([^"]+)"/i);
  return m ? m[1].trim().toUpperCase() : null;
}
function tipoComprobante(xml) {
  const m = xml.match(/\bTipoDeComprobante="([^"]+)"/);
  return m ? m[1].trim().toUpperCase() : null;
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, rfc: true, razonSocial: true } });
  let totalScanned = 0, totalFixable = 0, totalApplied = 0, totalUnparseable = 0;

  for (const co of companies) {
    const coRfc = (co.rfc ?? "").trim().toUpperCase();
    if (!coRfc) continue;
    const invoices = await prisma.invoice.findMany({
      where: { companyId: co.id, tipo: { in: ["INGRESO", "EGRESO"] }, rawXml: { not: null } },
      select: { id: true, tipo: true, rawXml: true },
    });

    let fixable = 0;
    const toFix = [];
    for (const inv of invoices) {
      totalScanned++;
      const tc = tipoComprobante(inv.rawXml);
      // Only regular comprobantes (I/E) are direction-ambiguous. Skip anything else.
      if (tc && tc !== "I" && tc !== "E") continue;
      const emi = emisorRfc(inv.rawXml);
      if (!emi) { totalUnparseable++; continue; }
      const correct = emi === coRfc ? "INGRESO" : "EGRESO";
      if (correct !== inv.tipo) { fixable++; toFix.push({ id: inv.id, from: inv.tipo, to: correct }); }
    }

    if (fixable > 0) {
      totalFixable += fixable;
      console.log(`\n${co.razonSocial} (${coRfc}) — ${fixable} mal clasificada(s) de ${invoices.length}`);
      if (APPLY) {
        const ingresoIds = toFix.filter((x) => x.to === "INGRESO").map((x) => x.id);
        const egresoIds = toFix.filter((x) => x.to === "EGRESO").map((x) => x.id);
        if (egresoIds.length) await prisma.invoice.updateMany({ where: { id: { in: egresoIds } }, data: { tipo: "EGRESO" } });
        if (ingresoIds.length) await prisma.invoice.updateMany({ where: { id: { in: ingresoIds } }, data: { tipo: "INGRESO" } });
        totalApplied += toFix.length;
        console.log(`  ✅ corregidas: ${egresoIds.length} → EGRESO, ${ingresoIds.length} → INGRESO`);
      }
    }
  }

  console.log("\n──────────────────────────────────────────────");
  console.log(`Escaneadas: ${totalScanned} · Mal clasificadas: ${totalFixable} · Sin emisor parseable: ${totalUnparseable}`);
  console.log(APPLY ? `Corregidas: ${totalApplied}` : "DRY RUN — corre con --apply para aplicar.");
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
