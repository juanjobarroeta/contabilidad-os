import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Admin123!", 10);

  const user = await prisma.user.upsert({
    where: { email: "admin@contabilidad-os.com" },
    update: {},
    create: {
      email: "admin@contabilidad-os.com",
      name: "Administrador",
      password: passwordHash,
    },
  });

  console.log("✅ User created:", user.email);

  const company = await prisma.company.upsert({
    where: { rfc: "XAXX010101000" },
    update: {},
    create: {
      razonSocial: "Mi Empresa SA de CV",
      rfc: "XAXX010101000",
      regimenFiscal: "601",
      codigoPostal: "06600",
      members: {
        create: { userId: user.id, role: "OWNER" },
      },
    },
  });

  console.log("✅ Company created:", company.razonSocial);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
