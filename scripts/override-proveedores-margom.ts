/**
 * Override del gigante 201.01 (proveedores) para MARGOM: CXP PLANTA VEHICULOS.
 *
 * Evidencia (2024-10 → 2026-06, medida antes de proponer): el motor abona
 * $3.71B al stub 201.01; en la CE presentada, 2002-0001 CXP PLANTA VEHICULOS
 * mueve ~$4.07B por lado — 91% de coincidencia. La otra grande (2000-0001
 * CXP FINANCIERA, plan piso) es flujo bancario, no CFDIs. De los cuatro
 * gigantes es el ÚNICO con una candidata dominante respaldada por documentos;
 * clientes (105.01) se reparte en tres y va por resolución de módulo, no por
 * override.
 *
 * Reversible: borrar la fila de PostingCuentaOverride y re-postear.
 *
 * Uso (dry-run por default; APPLY=1 escribe):
 *   DATABASE_URL=<url> [APPLY=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/override-proveedores-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const CODIGO_MOTOR = "201.01";
const CUENTA_DESTINO = "2002-0001-0000"; // CXP PLANTA VEHICULOS
const APPLY = process.env.APPLY === "1";

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    const cuenta = await prisma.chartAccount.findFirst({
      where: { companyId: COMPANY, cuentaSAT: CUENTA_DESTINO, isActive: true },
    });
    if (!cuenta) throw new Error(`${CUENTA_DESTINO} no existe o está inactiva`);

    const existente = await prisma.postingCuentaOverride.findUnique({
      where: { companyId_codigoMotor: { companyId: COMPANY, codigoMotor: CODIGO_MOTOR } },
      include: { cuenta: true },
    });
    if (existente) {
      console.log(`ya existe: ${CODIGO_MOTOR} → ${existente.cuenta.cuentaSAT} (${existente.cuenta.nombre}). No se toca.`);
      return;
    }

    console.log(`${APPLY ? "APLICA" : "[dry] "} ${CODIGO_MOTOR} → ${cuenta.cuentaSAT}  ${cuenta.nombre}`);
    if (APPLY) {
      await prisma.postingCuentaOverride.create({
        data: { companyId: COMPANY, codigoMotor: CODIGO_MOTOR, chartAccountId: cuenta.id },
      });
      console.log("listo. Re-postear la historia para que la migración surta efecto.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
