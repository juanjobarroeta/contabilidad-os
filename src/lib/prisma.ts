import { PrismaClient } from "@prisma/client";
import { decimalesANumero } from "./prisma-decimal";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Cliente compartido + conversión Decimal→number sobre TODO resultado
// (modelos, aggregate/groupBy, $queryRaw) — ver docs/FLOAT-DECIMAL.md. El
// $allOperations raíz intercepta también las queries crudas. El cast de
// regreso a PrismaClient conserva los tipos actuales: los helpers tipados con
// `PrismaClient | Prisma.TransactionClient` no cambian, y no usamos ninguna
// capacidad extra del cliente extendido.
function crearPrisma(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
  return base.$extends({
    query: {
      async $allOperations({ query, args }) {
        return decimalesANumero(await query(args));
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? crearPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
