// Dry run CE para la demo: genera los 5 XML del Anexo 24 de la empresa demo
// por cada mes posteado y los deja en disco para validarlos contra XSD.
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { generateCatalogoXml, generateBalanzaXml } from "../src/lib/contabilidad/coe-xml";
import { generatePolizasXmlDetallado } from "../src/lib/contabilidad/coe-polizas";
import { generateAuxiliarCtasXml, generateAuxiliarFoliosXml } from "../src/lib/contabilidad/coe-auxiliares";

const OUT = process.env.OUT_DIR ?? ".";

async function main() {
  const company = await prisma.company.findFirst({ where: { rfc: "CAL150612DM4" }, select: { id: true } });
  if (!company) throw new Error("demo company not found");
  const meses: Array<[number, number]> = [[2026, 5], [2026, 6], [2026, 7]];

  for (const [year, month] of meses) {
    const tag = `${year}-${String(month).padStart(2, "0")}`;
    const cat = await generateCatalogoXml({ companyId: company.id, year, month });
    writeFileSync(`${OUT}/catalogo-${tag}.xml`, cat);
    const bal = await generateBalanzaXml({ companyId: company.id, year, month });
    writeFileSync(`${OUT}/balanza-${tag}.xml`, typeof bal === "string" ? bal : bal.xml);
    const pol = await generatePolizasXmlDetallado({ companyId: company.id, year, month, tipoSolicitud: "AF", numOrden: "AGD1800000/00" });
    writeFileSync(`${OUT}/polizas-${tag}.xml`, pol.xml);
    console.log(`${tag} pólizas: bancarias=${pol.bancarias} sinEvidencia=${pol.sinEvidencia}`);
    const auxC = await generateAuxiliarCtasXml({ companyId: company.id, year, month, tipoSolicitud: "AF", numOrden: "AGD1800000/00" });
    writeFileSync(`${OUT}/auxctas-${tag}.xml`, auxC);
    const auxF = await generateAuxiliarFoliosXml({ companyId: company.id, year, month, tipoSolicitud: "AF", numOrden: "AGD1800000/00" });
    writeFileSync(`${OUT}/auxfolios-${tag}.xml`, auxF);
  }
  console.log("OK: 15 archivos generados");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
