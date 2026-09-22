/**
 * Pasa a bytes (ComplianceSnapshot.acusePdf) los acuses que sólo existían como
 * referencia: la data URL que el proveedor IMSS dejaba en acuseUrl y las
 * referencias a archivos de Syntage (se bajan con SYNTAGE_API_KEY mientras el
 * proveedor siga vivo). Idempotente: lo que ya tiene bytes no se toca.
 *
 * Uso: DATABASE_URL=… [SYNTAGE_API_KEY=…] npx tsx scripts/cumplimiento-acuse-a-bytes.ts [--max 200] [--solo-data-url]
 */
import { prisma } from "../src/lib/prisma";
import { asegurarAcusePdf, type DescargaAcuse, type EstadoAcusePdf } from "../src/lib/fiscal/cumplimiento/persist";
import { SyntageClient } from "../src/lib/fiscal/cumplimiento/syntage/client";

const i = process.argv.indexOf("--max");
const MAX = i >= 0 ? Number(process.argv[i + 1]) : 500;
const SOLO_DATA_URL = process.argv.includes("--solo-data-url");

async function main() {
  let descargar: DescargaAcuse | undefined;
  if (!SOLO_DATA_URL && process.env.SYNTAGE_API_KEY) {
    const client = new SyntageClient();
    descargar = (ref) => client.downloadAcuse(ref);
  }
  const pendientes = await prisma.complianceSnapshot.findMany({
    where: { acusePdfNombre: null, acuseUrl: { not: null } },
    orderBy: { fetchedAt: "desc" },
    take: MAX,
    select: { id: true, companyId: true, tipo: true, acuseUrl: true },
  });
  const conteo: Record<EstadoAcusePdf, number> = { ya_tenia: 0, guardado: 0, sin_fuente: 0, sin_snapshot: 0, error: 0 };
  for (const s of pendientes) {
    const esDataUrl = s.acuseUrl!.startsWith("data:");
    if (SOLO_DATA_URL && !esDataUrl) { conteo.sin_fuente++; continue; }
    const r = await asegurarAcusePdf(s.companyId, s.tipo, descargar, s.id);
    conteo[r.estado]++;
    if (r.estado === "error") console.error(`  ${s.tipo} ${s.id}: ${r.error}`);
  }
  console.log(`pendientes=${pendientes.length}`, conteo, descargar ? "(con Syntage)" : "(sólo data URLs)");
  await prisma.$disconnect();
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
