import { defineConfig } from "vitest/config";
import path from "node:path";

// Suite de INTEGRACIÓN (P0-2b): corre contra Postgres real, separada de la
// suite pura (vitest.config.ts) para que `npm test` siga siendo instantánea
// y sin dependencias. Convención: *.itest.ts.
//
// Local:
//   createdb contabilidad_os_test && psql -d contabilidad_os_test -c 'CREATE EXTENSION IF NOT EXISTS vector'
//   TEST_DATABASE_URL=postgresql://localhost:5432/contabilidad_os_test npx prisma db push --skip-generate
//   TEST_DATABASE_URL=postgresql://localhost:5432/contabilidad_os_test npm run test:db
// CI: job `authz-db` en .github/workflows/test.yml (contenedor pgvector).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.itest.ts"],
    setupFiles: ["./vitest.integration.setup.ts"],
    // Los tests comparten fixtures en una sola BD: sin paralelismo de archivos.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
