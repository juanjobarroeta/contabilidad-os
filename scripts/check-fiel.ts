/**
 * ¿Una empresa tiene FIEL cargada y está cifrada? Sólo estado, NO imprime secretos.
 * Uso: DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> ts-node ... scripts/check-fiel.ts
 */
import { prisma } from "../src/lib/prisma";
import { resolverEmpresa } from "./lib/empresa";

function estado(v: string | null): string {
  if (!v) return "FALTA";
  return v.startsWith("enc:v1:") ? `cifrado (${v.length})` : `claro (${v.length})`;
}

async function main() {
  const e = await resolverEmpresa(prisma);
  const c = await prisma.company.findUnique({
    where: { id: e.id },
    select: { razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  console.log(`${c?.razonSocial ?? e.rfc}:`);
  console.log(`  cer  = ${estado(c?.fielCer ?? null)}`);
  console.log(`  key  = ${estado(c?.fielKey ?? null)}`);
  console.log(`  pass = ${estado(c?.fielPassword ?? null)}`);
  const cifrado = [c?.fielCer, c?.fielKey, c?.fielPassword].some((v) => v?.startsWith("enc:v1:"));
  console.log(cifrado ? "→ cifrado: necesita CREDENTIALS_ENCRYPTION_KEY para descifrar." : "→ en claro: no necesita llave.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
