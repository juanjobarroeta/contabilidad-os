/**
 * One-time setup for the fiscal knowledge base: enables the pgvector
 * extension. Run BEFORE `npm run db:push` (the FiscalChunk.embedding column
 * needs the `vector` type to exist).
 *
 * Usage:
 *   DATABASE_URL=<url> npm run fiscal:setup
 *
 * Then:  npm run db:push  →  npm run fiscal:ingest-ley LISR
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  const [{ extversion }] = await prisma.$queryRawUnsafe<{ extversion: string }[]>(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
  );
  console.log(`✓ pgvector habilitado (v${extversion})`);
  console.log("Siguiente: npm run db:push  →  npm run fiscal:ingest-ley LISR");
}

main()
  .catch((e) => {
    console.error("✗ No se pudo habilitar pgvector:", e.message);
    console.error("  En Postgres administrado (Neon/Supabase/RDS) el owner de la BD puede crearla;");
    console.error("  si falla por permisos, habilítala desde el panel del proveedor.");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
