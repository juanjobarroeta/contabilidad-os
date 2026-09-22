/**
 * Repara las filas ISR_PROVISIONAL históricas de PERSONAS MORALES en que el
 * parser antiguo tomó las retenciones de nómina («ISR retenciones por
 * salarios/asimilados») como ISR propio: isrPagar > 0 con coeficiente 0/null.
 * Re-lee el acuse PDF guardado con el parser actual (que separa conceptos):
 *   • isrPagar ← ISR propio del acuse (normalmente 0).
 *   • crea la fila RETENCIONES_ISR del periodo (si no existe) con las
 *     retenciones de nómina enteradas y el mismo PDF.
 * Caso real: CENTRO (CPM2307076Z9), 7 meses de 2024–2026; el motor contaba
 * 42,360 de «pagos provisionales anteriores» en 2026 que el SAT no tiene.
 *
 * Uso: DATABASE_URL=… ANTHROPIC_API_KEY=… npx tsx scripts/reparar-acuses-isr-retenciones.ts [--rfc X] [--dry]
 */
import { prisma } from "../src/lib/prisma";
import { parseSatDocument, SatParsePagadoError } from "../src/lib/fiscal/acuse/parse";

const i = process.argv.indexOf("--rfc");
const RFC = i >= 0 ? process.argv[i + 1] : null;
const DRY = process.argv.includes("--dry");

async function main() {
  const filas = await prisma.taxDeclaration.findMany({
    where: {
      tipo: "ISR_PROVISIONAL", isHistorical: true, isrPagar: { gt: 0 },
      OR: [{ isrCoeficienteUtilidad: null }, { isrCoeficienteUtilidad: 0 }],
      acusePdf: { not: null },
      company: { regimenFiscal: { in: ["601", "603", "620", "622", "623", "624"] }, ...(RFC ? { rfc: RFC } : {}) },
    },
    select: { id: true, companyId: true, periodo: true, isrPagar: true, acusePdf: true, acusePdfNombre: true, company: { select: { rfc: true } } },
    orderBy: [{ companyId: "asc" }, { periodo: "asc" }],
  });
  console.log(`candidatas: ${filas.length}${DRY ? " (dry)" : ""}`);
  let corregidas = 0, retenciones = 0, sinCambio = 0, errores = 0;
  for (const f of filas) {
    let parsed;
    try {
      parsed = await parseSatDocument(Buffer.from(f.acusePdf!).toString("base64"), { companyId: f.companyId, subtipo: "declaraciones.reparar_retenciones" });
    } catch (e) {
      errores++; console.log(` ${f.company.rfc} ${f.periodo}: error ${e instanceof SatParsePagadoError ? "pagado " : ""}${(e as Error).message.slice(0, 80)}`); continue;
    }
    const a = parsed.acuseMensual;
    if (parsed.type !== "ACUSE_MENSUAL" || !a) { errores++; console.log(` ${f.company.rfc} ${f.periodo}: tipo ${parsed.type}`); continue; }
    const isrPropio = a.isrAPagar ?? 0;
    const ret = a.retencionesSalarios ?? null;
    console.log(` ${f.company.rfc} ${f.periodo}: isrPagar ${f.isrPagar} → ${isrPropio} · retenciones nómina ${ret ?? "—"}${a.retencionesTerceros != null ? ` · terceros ${a.retencionesTerceros}` : ""}`);
    if (DRY) continue;
    if (isrPropio !== Number(f.isrPagar ?? 0)) {
      await prisma.taxDeclaration.update({ where: { id: f.id }, data: { isrPagar: isrPropio, acuseParseadoAt: new Date() } });
      corregidas++;
    } else sinCambio++;
    if (ret != null) {
      const existe = await prisma.taxDeclaration.findFirst({ where: { companyId: f.companyId, tipo: "RETENCIONES_ISR", periodo: f.periodo }, select: { id: true } });
      if (!existe) {
        await prisma.taxDeclaration.create({
          data: {
            companyId: f.companyId, tipo: "RETENCIONES_ISR", periodo: f.periodo, status: "FILED", isHistorical: true,
            retencionesIsr: ret, acuseParseadoAt: new Date(),
            ...(f.acusePdf ? { acusePdf: new Uint8Array(f.acusePdf), acusePdfNombre: f.acusePdfNombre ?? `acuse-${f.periodo}.pdf` } : {}),
          },
        });
        retenciones++;
      }
    }
  }
  console.log({ corregidas, retencionesCreadas: retenciones, sinCambio, errores });
  await prisma.$disconnect();
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
