export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness must not import auth, Prisma, or any external provider client.
export function GET() {
  return Response.json({ status: "ok" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
