/**
 * Prende (o apaga) el flag de OPERADOR de plataforma en un usuario.
 *
 * Un operador supervisa CROSS-despacho: ve y opera TODAS las empresas activas
 * de TODOS los despachos (soporte/supervisión de pilotos). Es un privilegio
 * de plataforma — por eso sólo se activa por script, NUNCA self-serve ni por
 * ninguna ruta de la app. Úsalo con cuidado y sólo para cuentas de operación.
 *
 * Uso:
 *   cd <repo>
 *   set -a; . ./.env.local; set +a            # carga DATABASE_URL
 *   node scripts/set-operador.mjs <email>             # prende el flag
 *   node scripts/set-operador.mjs <email> off         # apaga el flag
 *
 * Ejemplo:
 *   node scripts/set-operador.mjs juanjosebarroetah@gmail.com
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const [, , emailArg, modeArg] = process.argv;

if (!emailArg) {
  console.error("Uso: node scripts/set-operador.mjs <email> [off]");
  process.exit(1);
}

const EMAIL = emailArg.trim().toLowerCase();
const ENABLE = (modeArg ?? "on").trim().toLowerCase() !== "off";

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, email: true, name: true, esOperador: true },
  });
  if (!user) {
    console.error(`❌ No existe un usuario con email ${EMAIL}.`);
    process.exit(1);
  }

  if (user.esOperador === ENABLE) {
    console.log(
      `✓ ${user.email} ya tiene esOperador=${ENABLE} — sin cambios.`
    );
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { esOperador: ENABLE },
  });

  console.log(
    ENABLE
      ? `✓ ${user.email} ahora es OPERADOR de plataforma — ve y opera TODAS las empresas activas de todos los despachos.`
      : `✓ ${user.email} ya NO es operador — vuelve a su acceso normal por membresías.`
  );
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
