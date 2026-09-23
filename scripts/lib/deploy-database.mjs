/**
 * Existing pre-deploy algorithm, separated from the CLI for failure-path tests.
 * Errors deliberately propagate: the entrypoint exits 1 and Railway stops.
 * @param {Pick<import("@prisma/client").PrismaClient, "$queryRawUnsafe" | "$disconnect">} prisma
 * @param {(command: string) => void} run
 * @param {(message: string) => void} log
 */
export async function deployDatabase(prisma, run, log = console.log) {
  let tieneEsquema = false;
  let tieneHistorial = false;
  try {
    const filas = await prisma.$queryRawUnsafe(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'Company')   AS esquema,
         EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = '_prisma_migrations') AS historial`
    );
    tieneEsquema = Boolean(filas?.[0]?.esquema);
    tieneHistorial = Boolean(filas?.[0]?.historial);
  } finally {
    await prisma.$disconnect();
  }

  log(`[deploy-db] esquema existente: ${tieneEsquema} · historial de migraciones: ${tieneHistorial}`);
  if (tieneEsquema && !tieneHistorial) {
    log("[deploy-db] Base existente sin historial — aplicando baseline 0_init (resolve, no toca el esquema).");
    run("npx prisma migrate resolve --applied 0_init");
  }
  run("npx prisma migrate deploy");
  log("[deploy-db] Esquema al día.");
}
