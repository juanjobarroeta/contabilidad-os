// ─────────────────────────────────────────────────────────────────────────────
// Da de alta (o actualiza) un usuario del copiloto jurídico: cuenta del hub con
// contraseña y `accesoJuridico` encendido, sin empresa, sin ser operador.
//
//   DATABASE_URL=… npx tsx scripts/crear-usuario-juridico.ts <email> "<nombre>" [contraseña]
//
// Sin contraseña genera una (se imprime UNA vez). El abogado entra al satélite
// con ese correo y contraseña; la cambia en el hub (/api/auth/change-password).
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const [email, nombre, contrasenaArg] = process.argv.slice(2);
if (!email || !nombre) {
  console.error('Uso: npx tsx scripts/crear-usuario-juridico.ts <email> "<nombre>" [contraseña]');
  process.exit(1);
}
const contrasena = contrasenaArg ?? randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 12);

async function main() {
const prisma = new PrismaClient();
const hash = await bcrypt.hash(contrasena, 10);
const u = await prisma.user.upsert({
  where: { email: email.trim().toLowerCase() },
  // ACTIVE = cortesía: sin empresa ni cargo; un TRIALING vencido cerraría la puerta del token.
  create: { email: email.trim().toLowerCase(), name: nombre, password: hash, accesoJuridico: true, emailVerified: new Date(), subscriptionStatus: "ACTIVE" },
  update: { name: nombre, password: hash, accesoJuridico: true, subscriptionStatus: "ACTIVE" },
  select: { id: true, email: true, name: true, accesoJuridico: true, esOperador: true, subscriptionStatus: true },
});
console.log(JSON.stringify(u));
console.log(`contraseña: ${contrasena}`);
await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
