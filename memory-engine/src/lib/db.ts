import { PrismaClient } from '@prisma/client'

// Next's dev server re-evaluates modules on every edit; without the global the
// connection pool grows until Postgres refuses new clients.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
