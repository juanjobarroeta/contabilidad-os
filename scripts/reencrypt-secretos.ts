// Re-cifrado ÚNICO de secretos legados (previos al rollout de crypto.ts).
//
// El diseño original re-cifraba "en la siguiente escritura" — las empresas
// viejas nunca reescribieron, y sus llaves FIEL/CSD y contraseñas quedaron en
// claro en la base (visto en prod: 9 FIEL y 8 CSD en PLANO). Este script lee
// con decryptSecret (passthrough para lo plano) y reescribe con encryptSecret.
// Idempotente: lo ya cifrado se salta.
//
// Uso: npx tsx scripts/reencrypt-secretos.ts [--apply]
import { prisma } from "../src/lib/prisma";
import { decryptSecret, encryptSecret, isEncrypted, encryptionConfigured } from "../src/lib/crypto";

const APPLY = process.argv.includes("--apply");
const COLS = ["fielCer", "fielKey", "fielPassword", "csdCer", "csdKey", "csdPassword", "facturapiApiKey"] as const;

async function main() {
  if (!encryptionConfigured()) { console.error("CREDENTIALS_ENCRYPTION_KEY no configurada — abortando."); process.exit(1); }
  const companies = await prisma.company.findMany({
    select: { id: true, rfc: true, ...Object.fromEntries(COLS.map((c) => [c, true])) },
  });
  let tocadas = 0;
  for (const c of companies) {
    const data: Record<string, string> = {};
    for (const col of COLS) {
      const v = (c as Record<string, unknown>)[col];
      if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) {
        data[col] = encryptSecret(decryptSecret(v));
      }
    }
    const cols = Object.keys(data);
    if (cols.length === 0) continue;
    tocadas++;
    console.log(`${c.rfc}: ${cols.join(", ")}${APPLY ? "" : " [dry-run]"}`);
    if (APPLY) await prisma.company.update({ where: { id: c.id }, data });
  }
  console.log(`${tocadas} empresa(s) con secretos en claro${APPLY ? " — RE-CIFRADAS" : " · dry-run (usa --apply)"}`);
  await prisma.$disconnect();
}
main();
