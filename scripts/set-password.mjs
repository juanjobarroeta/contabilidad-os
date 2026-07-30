/**
 * Restablece la contraseña de un usuario (rescate cuando no puede entrar y
 * aún no existe flujo de "olvidé mi contraseña" en la app).
 *
 * Uso (dentro del contenedor de Railway, DATABASE_URL ya en el entorno):
 *   node scripts/set-password.mjs correo@dominio.com 'NuevaContraseña'
 *
 * - El correo se busca sin distinguir mayúsculas.
 * - La contraseña debe tener al menos 8 caracteres.
 * - Sólo actualiza el hash; no toca despachos, membresías ni suscripción.
 * - Cambia la contraseña desde la app después de entrar si fue temporal.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Uso: node scripts/set-password.mjs correo@dominio.com 'NuevaContraseña'");
  process.exit(1);
}
if (password.length < 8) {
  console.error("La contraseña debe tener al menos 8 caracteres.");
  process.exit(1);
}

const user = await prisma.user.findFirst({
  where: { email: { equals: email.trim(), mode: "insensitive" } },
  select: { id: true, email: true, name: true },
});

if (!user) {
  console.error(`No existe un usuario con el correo ${email}`);
  process.exit(1);
}

await prisma.user.update({
  where: { id: user.id },
  data: { password: await bcrypt.hash(password, 10) },
});

console.log(`Contraseña actualizada para ${user.email} (${user.name ?? "sin nombre"}).`);
await prisma.$disconnect();
