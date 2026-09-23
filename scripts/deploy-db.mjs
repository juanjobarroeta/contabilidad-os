// Despliegue de esquema con prisma migrate (sustituye a `db push --accept-data-loss`).
//
// Tres escenarios, decididos automáticamente en cada deploy:
//   1. Base EXISTENTE sin historial de migraciones (producción el día del cambio):
//      se hace baseline — `migrate resolve --applied 0_init` marca la migración
//      inicial como aplicada SIN tocar el esquema, y luego `migrate deploy`
//      aplica solo lo pendiente (nada, ese día).
//   2. Base con historial: `migrate deploy` aplica las migraciones pendientes.
//   3. Base VACÍA (staging nuevo, entorno fresco): `migrate deploy` corre 0_init
//      completo y crea todo el esquema.
//
// Si algo falla, el proceso sale con código distinto de cero y Railway aborta el
// deploy (la imagen anterior sigue sirviendo) — igual de seguro que antes, pero
// sin el riesgo de `--accept-data-loss` borrando columnas en un rename.
//
// A partir de este cambio, TODA modificación de prisma/schema.prisma debe venir
// acompañada de su migración (`npx prisma migrate dev --name <cambio>` en local)
// — el diff de la migración es revisable en el PR. Ver docs/OPERACIONES.md §2.

import { execSync } from "node:child_process";
import pkg from "@prisma/client";
import { deployDatabase } from "./lib/deploy-database.mjs";

const { PrismaClient } = pkg;

function run(cmd) {
  console.log(`[deploy-db] $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function main() {
  await deployDatabase(new PrismaClient(), run);
}

main().catch((err) => {
  console.error("[deploy-db] FALLÓ — el deploy se aborta y la imagen anterior sigue sirviendo.");
  console.error(err);
  process.exit(1);
});
