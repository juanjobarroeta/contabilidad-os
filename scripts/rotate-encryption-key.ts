/**
 * One-time re-encryption when rotating CREDENTIALS_ENCRYPTION_KEY.
 *
 * Reads every stored credential field, decrypts it with the OLD key, and
 * re-encrypts with the NEW key. Legacy plaintext rows (pre-encryption) get
 * encrypted with the new key too. Safe to re-run: values already on the new
 * key won't decrypt with the old key (GCM auth fails) and are skipped.
 *
 * Usage (point DATABASE_URL at the target DB):
 *
 *   OLD_CREDENTIALS_ENCRYPTION_KEY=<old base64> \
 *   NEW_CREDENTIALS_ENCRYPTION_KEY=<new base64> \
 *   DATABASE_URL=<target db url> \
 *   DRY_RUN=1 \                       # preview without writing (optional)
 *   npm run rotate:key
 *
 * On Railway (DATABASE_URL injected automatically):
 *   railway run --service <app> \
 *     OLD_CREDENTIALS_ENCRYPTION_KEY=... NEW_CREDENTIALS_ENCRYPTION_KEY=... \
 *     npm run rotate:key
 *
 * After it succeeds, set CREDENTIALS_ENCRYPTION_KEY = the NEW key in the
 * environment and redeploy. (Keep the OLD key only until rotation completes.)
 */
import { PrismaClient } from "@prisma/client";
import {
  parseKey,
  encryptWithKey,
  decryptWithKey,
} from "../src/lib/crypto";

const FIELDS = [
  "csdCer",
  "csdKey",
  "csdPassword",
  "fielCer",
  "fielKey",
  "fielPassword",
  "facturapiApiKey",
] as const;

async function main() {
  const oldRaw = process.env.OLD_CREDENTIALS_ENCRYPTION_KEY;
  const newRaw = process.env.NEW_CREDENTIALS_ENCRYPTION_KEY;
  if (!oldRaw || !newRaw) {
    throw new Error(
      "Set both OLD_CREDENTIALS_ENCRYPTION_KEY and NEW_CREDENTIALS_ENCRYPTION_KEY"
    );
  }
  const oldKey = parseKey(oldRaw);
  const newKey = parseKey(newRaw);
  const dryRun = process.env.DRY_RUN === "1";

  const prisma = new PrismaClient();
  try {
    const companies = await prisma.company.findMany({
      select: {
        id: true,
        rfc: true,
        csdCer: true,
        csdKey: true,
        csdPassword: true,
        fielCer: true,
        fielKey: true,
        fielPassword: true,
        facturapiApiKey: true,
      },
    });

    let companiesChanged = 0;
    let fieldsRotated = 0;
    let skipped = 0;

    for (const company of companies) {
      const row = company as Record<string, string | null>;
      const data: Record<string, string> = {};

      for (const field of FIELDS) {
        const value = row[field];
        if (!value) continue;
        let plaintext: string;
        try {
          plaintext = decryptWithKey(value, oldKey); // legacy plaintext passes through
        } catch {
          // Couldn't decrypt with the OLD key — already on the new key, or
          // mismatched. Skip rather than corrupt it.
          console.warn(`  ! ${company.rfc}.${field}: not decryptable with OLD key — skipped`);
          skipped++;
          continue;
        }
        data[field] = encryptWithKey(plaintext, newKey);
        fieldsRotated++;
      }

      if (Object.keys(data).length === 0) continue;
      companiesChanged++;
      console.log(
        `${dryRun ? "[dry] " : ""}${company.rfc}: ${Object.keys(data).join(", ")}`
      );
      if (!dryRun) {
        await prisma.company.update({ where: { id: company.id }, data });
      }
    }

    console.log(
      `\nDone${dryRun ? " (DRY RUN — nothing written)" : ""}: ` +
        `${companiesChanged} companies, ${fieldsRotated} fields rotated, ${skipped} skipped.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
