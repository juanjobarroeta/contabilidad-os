/**
 * hospital-medicos-revisar.ts — reclasifica los HospMedico de una empresa por
 * lo que facturan (medicos-cfdi.ts) y, con --aplicar, desactiva a los que no
 * son médicos (arrendadores, proveedores, mantenimiento…). Los MIXTO se
 * dejan activos y se listan para que una persona confirme.
 *
 * Uso: npx tsx scripts/hospital-medicos-revisar.ts --rfc CPM2307076Z9 [--aplicar]
 */
import { PrismaClient } from "@prisma/client";
import { clasificarProveedorMedico } from "../src/lib/hospital/medicos-cfdi";

const prisma = new PrismaClient({ transactionOptions: { timeout: 120_000, maxWait: 30_000 } });
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const aplicar = process.argv.includes("--aplicar");

async function main() {
  const rfc = arg("--rfc");
  const companyId = arg("--company");
  if (!rfc && !companyId) throw new Error("Uso: --rfc <RFC> | --company <id> [--aplicar]");
  const company = await prisma.company.findFirst({ where: companyId ? { id: companyId } : { rfc: rfc! }, select: { id: true, razonSocial: true, rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");
  const medicos = await prisma.hospMedico.findMany({ where: { companyId: company.id }, orderBy: { nombre: "asc" } });
  console.log(`${company.razonSocial} (${company.rfc}) · ${medicos.length} médicos registrados\n`);
  const filas: Array<{ nombre: string; rfc: string; clasificacion: string; pct: number; motivos: string; facturas: number; accion: string }> = [];
  for (const m of medicos) {
    const conceptos = m.rfc
      ? await prisma.invoiceItem.findMany({
          where: { invoice: { companyId: company.id, tipo: "EGRESO", status: { not: "CANCELLED" }, contraparteRfc: m.rfc } },
          select: { claveProdServ: true, descripcion: true, importe: true, cuentaPredial: true, invoiceId: true },
        })
      : [];
    const r = clasificarProveedorMedico(conceptos.map((c) => ({ ...c, importe: Number(c.importe) })));
    const facturas = new Set(conceptos.map((c) => c.invoiceId)).size;
    // Sin CFDIs (médico capturado a mano, como los del demo) no se toca.
    const accion = conceptos.length === 0 ? "sin CFDI · se conserva" : r.clasificacion === "NO_MEDICO" ? (m.activo ? "desactivar" : "ya inactivo") : r.clasificacion === "MIXTO" ? "confirmar" : "médico";
    filas.push({ nombre: m.nombre, rfc: m.rfc ?? "", clasificacion: conceptos.length ? r.clasificacion : "-", pct: Math.round(r.proporcionMedica * 100), motivos: r.motivos.join(", "), facturas, accion });
    if (aplicar && accion === "desactivar") {
      await prisma.hospMedico.update({ where: { id: m.id }, data: { activo: false } });
    }
  }
  console.table(filas);
  const n = (a: string) => filas.filter((f) => f.accion === a).length;
  console.log(`\nmédicos: ${n("médico")} · confirmar (MIXTO): ${n("confirmar")} · ${aplicar ? "desactivados" : "a desactivar"}: ${n("desactivar")} · sin CFDI: ${n("sin CFDI · se conserva")}`);
  if (!aplicar && n("desactivar")) console.log("Corre con --aplicar para desactivarlos (reversible: activo=true en Médicos).");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
