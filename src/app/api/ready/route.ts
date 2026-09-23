import { prisma } from "@/lib/prisma";
import { createReadinessCheck } from "@/lib/operations/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exercise the same connection pool as the app, without reading tenant data.
// Schema migration acceptance belongs to the mandatory pre-deploy command.
const checkReadiness = createReadinessCheck(() => prisma.$queryRaw`SELECT 1`);

export async function GET() {
  const ready = await checkReadiness();
  return Response.json({ status: ready ? "ready" : "not_ready" }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
