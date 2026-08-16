/**
 * Re-deriva marca/modelo/versión de las unidades POR REVISAR de MARGOM desde el
 * texto de su propio CFDI (compra, o venta si no hay compra), usando EXACTAMENTE
 * el derivador de producción (generalesParaUnidad: catálogo Anexo 15 primero,
 * heurística de texto después).
 *
 * Por qué existe: la reparación en línea (auto-vehiculo.ts) sólo corre cuando un
 * CFDI vuelve a tocar la unidad — las unidades del piso no se tocan hasta que se
 * venden, así que una mejora del derivador no las alcanza sola. Este script las
 * re-pasa todas de una vez.
 *
 * Conservador e idempotente:
 *   • Sólo unidades autoCreado (lo editado a mano no se toca).
 *   • Sólo campos ROTOS: marca/modelo POR REVISAR o modelo puramente numérico
 *     (el código de producto que traían los autobuses Yutong). Un valor bueno
 *     nunca se pisa, y un campo roto nunca se pisa con otro POR REVISAR.
 *
 * Uso (apuntar DATABASE_URL a la base destino):
 *
 *   DATABASE_URL=<url> DRY_RUN=1 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/reparar-generales-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { conceptosConVeredicto } from "../src/lib/automotriz/vin";
import { generalesParaUnidad } from "../src/lib/automotriz/auto-vehiculo";

const DRY_RUN = process.env.DRY_RUN === "1";
const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM

const esNumerico = (s: string | null) => !!s && /^\d{4,}$/.test(s.trim());
const roto = (s: string | null) => s === "POR REVISAR" || esNumerico(s);

async function main() {
  const prisma = new PrismaClient();
  try {
    // El «modelo numérico» (~ regex) no se expresa en el where de Prisma:
    // los ids salen en SQL y el detalle con findMany.
    const candidatos = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Vehiculo"
      WHERE "companyId" = ${COMPANY} AND "autoCreado" = true
        AND (marca = 'POR REVISAR' OR modelo = 'POR REVISAR' OR modelo ~ '^[0-9]{4,}$')
    `;
    const unidades = await prisma.vehiculo.findMany({
      where: { id: { in: candidatos.map((c) => c.id) } },
      select: {
        id: true,
        vin: true,
        marca: true,
        modelo: true,
        version: true,
        anio: true,
        claveVehicular: true,
        compraInvoiceId: true,
        ventaInvoiceId: true,
      },
    });

    console.log(`${unidades.length} unidades con generales rotos`);
    let reparadas = 0;
    let sinMejora = 0;
    let sinCfdi = 0;

    for (const u of unidades) {
      const invoiceId = u.compraInvoiceId ?? u.ventaInvoiceId;
      const inv = invoiceId
        ? await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { rawXml: true } })
        : null;
      if (!inv?.rawXml) {
        sinCfdi++;
        continue;
      }

      // El concepto de ESTA unidad: por NIV del complemento o VIN en el texto.
      const concepto = conceptosConVeredicto(inv.rawXml).find(
        (c) => c.veredicto.niv === u.vin || c.vinsTexto.includes(u.vin),
      );
      if (!concepto) {
        sinCfdi++;
        continue;
      }

      const g = await generalesParaUnidad(
        prisma,
        {
          claveVehicular: concepto.claveVehicular ?? u.claveVehicular,
          descripcion: concepto.descripcion,
          noIdentificacion: concepto.noIdentificacion,
        },
        u.anio ?? new Date().getFullYear(),
      );

      const data: { marca?: string; modelo?: string; version?: string } = {};
      if (roto(u.marca) && g.marca !== "POR REVISAR" && g.marca !== u.marca) data.marca = g.marca;
      if (roto(u.modelo) && g.modelo !== "POR REVISAR" && g.modelo !== u.modelo) data.modelo = g.modelo;
      if (!u.version && g.version) data.version = g.version;

      if (Object.keys(data).length === 0) {
        sinMejora++;
        continue;
      }

      console.log(
        `  ${DRY_RUN ? "[dry-run] " : ""}${u.vin}: ` +
          `${u.marca}/${u.modelo} → ${data.marca ?? u.marca}/${data.modelo ?? u.modelo}` +
          (data.version ? ` (versión: ${data.version})` : ""),
      );
      if (!DRY_RUN) {
        await prisma.vehiculo.update({ where: { id: u.id }, data });
      }
      reparadas++;
    }

    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}listo: ${reparadas} reparadas, ` +
        `${sinMejora} sin mejora posible, ${sinCfdi} sin CFDI legible`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
