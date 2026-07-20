import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// GET /api/purificadora/rutas?companyId=xxx[&all=true]
// Rutas de reparto (Brayan, Angélica, Ventanilla…).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const all = searchParams.get("all") === "true";
  const rutas = await prisma.purifRuta.findMany({
    where: { companyId, ...(all ? {} : { activo: true }) },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(rutas);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1).max(80),
});

// POST /api/purificadora/rutas
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, nombre } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  try {
    const ruta = await prisma.purifRuta.create({ data: { companyId, nombre } });
    return NextResponse.json(ruta, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Ya existe una ruta con ese nombre" }, { status: 409 });
  }
});
