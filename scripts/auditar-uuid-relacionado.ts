/**
 * Busca facturas guardadas con el folio EQUIVOCADO: parseCfdiXml tomaba el
 * primer `UUID="` del XML, y en un CFDI con CfdiRelacionados (nota de crédito
 * 01, sustitución 04, aplicación de anticipo 07) ése es el del comprobante
 * RELACIONADO, no el del timbre. Sólo afectaba lo que entra por
 * importCfdiFromXml (subida manual del XML, WhatsApp); la descarga del SAT y
 * Syntage usan el UUID de la metadata.
 *
 * Dos daños posibles por fila:
 *   • la fila lleva el folio de su factura relacionada → se corrige al del
 *     timbre (--apply), salvo que otra fila de la empresa ya lo tenga;
 *   • la factura relacionada verdadera se habrá tomado por «existente» al
 *     descargarse y NO está en la base → se lista como «padre ausente» para
 *     re-descargarla después de corregir.
 *
 * Por defecto sólo lee e imprime conteos por empresa.
 *
 * Uso: DATABASE_URL=… npx tsx scripts/auditar-uuid-relacionado.ts [--rfc X] [--apply]
 */
import { prisma } from "../src/lib/prisma";
import { uuidDelTimbre } from "../src/lib/sat-fiel";

const i = process.argv.indexOf("--rfc");
const RFC = i >= 0 ? process.argv[i + 1] : null;
const APPLY = process.argv.includes("--apply");
const LOTE = 500;

interface PorEmpresa {
  rfc: string;
  afectadas: number;
  corregidas: number;
  conflicto: number;
  padreAusente: number;
}

async function main() {
  const porEmpresa = new Map<string, PorEmpresa>();
  let revisadas = 0;
  let cursor: string | undefined;

  for (;;) {
    const filas = await prisma.invoice.findMany({
      where: {
        rawXml: { contains: "CfdiRelacionado" },
        uuid: { not: null },
        ...(RFC ? { company: { rfc: RFC } } : {}),
      },
      select: { id: true, companyId: true, uuid: true, rawXml: true, company: { select: { rfc: true } } },
      orderBy: { id: "asc" },
      take: LOTE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (filas.length === 0) break;
    cursor = filas[filas.length - 1].id;
    revisadas += filas.length;

    for (const f of filas) {
      const delTimbre = uuidDelTimbre(f.rawXml as string);
      const guardado = (f.uuid as string).toUpperCase();
      if (!delTimbre || delTimbre === guardado) continue;

      const e =
        porEmpresa.get(f.companyId) ??
        { rfc: f.company.rfc, afectadas: 0, corregidas: 0, conflicto: 0, padreAusente: 0 };
      porEmpresa.set(f.companyId, e);
      e.afectadas++;

      // El folio guardado era el de la factura relacionada: ¿existe esa factura
      // como fila propia? Si no, la descarga la dio por repetida.
      const padre = await prisma.invoice.findFirst({
        where: { companyId: f.companyId, id: { not: f.id }, uuid: { equals: guardado, mode: "insensitive" } },
        select: { id: true },
      });
      if (!padre) e.padreAusente++;

      const ocupado = await prisma.invoice.findFirst({
        where: { companyId: f.companyId, id: { not: f.id }, uuid: { equals: delTimbre, mode: "insensitive" } },
        select: { id: true },
      });
      console.log(
        ` ${f.company.rfc} ${f.id}: ${guardado} → ${delTimbre}` +
          `${ocupado ? " · CONFLICTO (otra fila ya tiene el folio del timbre)" : ""}` +
          `${padre ? "" : " · padre ausente"}`,
      );
      if (ocupado) {
        e.conflicto++;
        continue;
      }
      if (APPLY) {
        await prisma.invoice.update({ where: { id: f.id }, data: { uuid: delTimbre } });
        e.corregidas++;
      }
    }
  }

  console.log(`\nrevisadas con CfdiRelacionados: ${revisadas}${APPLY ? "" : " (sólo lectura; --apply corrige)"}`);
  console.table([...porEmpresa.values()]);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
