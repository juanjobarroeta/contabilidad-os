// Corre ANTES de que vitest importe los archivos *.itest.ts (setupFiles):
// resuelve la URL de la base y BLOQUEA el paso a cualquier base que no sea
// de prueba. En este repo la BD de desarrollo puede tener datos fiscales
// reales — un test que la toque por accidente es un incidente, no un flake.

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  if (process.env.REQUIRE_DB_TESTS === "1") {
    // En CI el skip silencioso es exactamente la podredumbre que P0-2 combate.
    throw new Error(
      "REQUIRE_DB_TESTS=1 pero falta TEST_DATABASE_URL: el job está mal configurado; esto es un error, no un skip."
    );
  }
  process.env.DB_TESTS_SKIP = "1";
  // Si algún import dispara un query pese al skip, que truene en un puerto
  // muerto en vez de caer en la BD de desarrollo del DATABASE_URL heredado.
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/bloqueada";
} else {
  if (!/test/i.test(url)) {
    throw new Error(
      `TEST_DATABASE_URL no parece una base de prueba (la URL debe contener "test"): ${url.replace(/:[^:@/]+@/, ":***@")}`
    );
  }
  process.env.DATABASE_URL = url;
}

// authz importa lib/auth (NextAuth) y api-token firma con AUTH_SECRET.
process.env.AUTH_SECRET ??= "secreto-de-prueba-para-itest-authz-32b";
process.env.NEXTAUTH_SECRET ??= process.env.AUTH_SECRET;

export {};
