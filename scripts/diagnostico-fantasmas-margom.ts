/**
 * Diagnóstico SÓLO LECTURA: ¿por qué la venta emitida de cada unidad fantasma
 * no la marcó como vendida? Corre el MISMO gate de producción
 * (conceptosConVeredicto) sobre el rawXml de cada CFDI de venta candidato, y
 * reporta el veredicto del concepto que trae el VIN + el rol que quedó en el
 * expediente (VehiculoCfdi) + el ciclo vigente.
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";
import { conceptosConVeredicto } from "../src/lib/automotriz/vin";

const CUTOFF = "2026-06-30";

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    const fantasmas = await prisma.$queryRawUnsafe<
      { vehiculoId: string; vin: string; compra: Date; invId: string; uuid: string; fecha: Date }[]
    >(`
      WITH piso AS (
        SELECT v.id "vehiculoId", v.vin, COALESCE(v."fechaCompra", v."createdAt")::date compra
        FROM "Vehiculo" v
        WHERE v."companyId"='${COMPANY}'
          AND COALESCE(v."fechaCompra", v."createdAt")::date <= '${CUTOFF}'
          AND (v."fechaVenta" IS NULL OR v."fechaVenta"::date > '${CUTOFF}')
          AND v.vin IS NOT NULL
      ),
      ventas AS (
        SELECT i.id "invId", i.uuid, i.fecha::date fecha,
               (regexp_matches(i."rawXml", '(?<![A-Z0-9])([A-HJ-NPR-Z0-9]{17})', 'g'))[1] vin
        FROM "Invoice" i
        WHERE i."companyId"='${COMPANY}' AND i.tipo='INGRESO'
          AND i.status IS DISTINCT FROM 'CANCELLED'
          AND i."rawXml" ~ 'Emisor[^>]*Rfc="AMA170817NK1"'
      )
      SELECT DISTINCT p."vehiculoId", p.vin, p.compra, v."invId", v.uuid, v.fecha
      FROM piso p JOIN ventas v ON v.vin = p.vin AND v.fecha > p.compra AND v.fecha <= '${CUTOFF}'
      ORDER BY p.vin, v.fecha
    `);

    console.log(`${fantasmas.length} pares (unidad en piso, CFDI de venta emitido)\n`);

    for (const f of fantasmas) {
      const inv = await prisma.invoice.findUnique({
        where: { id: f.invId },
        select: { rawXml: true, total: true },
      });
      const mencion = await prisma.vehiculoCfdi.findUnique({
        where: { vehiculoId_invoiceId: { vehiculoId: f.vehiculoId, invoiceId: f.invId } },
        select: { rol: true },
      });
      // ¿Qué ciclo considera vigente el sistema para este VIN?
      const ciclos = await prisma.vehiculo.findMany({
        where: { companyId: COMPANY, vin: f.vin },
        select: { id: true, ciclo: true, estado: true, fechaVenta: true },
        orderBy: { ciclo: "asc" },
      });

      const linea: string[] = [];
      linea.push(`${f.vin} compra=${f.compra.toISOString().slice(0, 10)} venta=${f.fecha.toISOString().slice(0, 10)} uuid=${f.uuid.slice(0, 8)}`);
      linea.push(`  expediente: ${mencion?.rol ?? "SIN MENCIÓN (¿no procesado?)"}`);
      linea.push(`  ciclos: ${ciclos.map((c) => `#${c.ciclo}:${c.estado}${c.id === f.vehiculoId ? "*" : ""}`).join(" ")}`);

      if (!inv?.rawXml) {
        linea.push("  SIN rawXml");
        console.log(linea.join("\n") + "\n");
        continue;
      }
      const conceptos = conceptosConVeredicto(inv.rawXml);
      const delVin = conceptos.filter(
        (c) => c.veredicto.niv === f.vin || c.vinsTexto.includes(f.vin) || (c.descripcion ?? "").toUpperCase().includes(f.vin),
      );
      if (delVin.length === 0) {
        // El VIN está en el XML (lo encontró el regex SQL) pero NINGÚN concepto
        // lo reporta: vinsDesdeTexto no lo ve (VIN pegado a otra palabra, o
        // está fuera de Descripcion/NoIdentificacion).
        const enTexto = conceptos.filter((c) => (c.descripcion ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes(f.vin));
        linea.push(`  concepto del VIN: NINGUNO lo reporta (vinsDesdeTexto ciego) — ${enTexto.length} concepto(s) lo traen pegado en el texto`);
        if (enTexto[0]) linea.push(`    ej: "${(enTexto[0].descripcion ?? "").slice(0, 110)}" importe=${enTexto[0].importe}`);
      }
      for (const c of delVin) {
        linea.push(
          `  concepto: complemento=${c.veredicto.porComplemento} esUnidad=${c.veredicto.esUnidad} fallas=[${c.veredicto.fallas.join(",")}] ` +
            `clave=${c.claveProdServ} cant=${c.cantidad} importe=${c.importe} vinsTexto=${c.vinsTexto.length}`,
        );
        if (!c.veredicto.esUnidad) linea.push(`    desc: "${(c.descripcion ?? "").slice(0, 110)}"`);
      }
      console.log(linea.join("\n") + "\n");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
