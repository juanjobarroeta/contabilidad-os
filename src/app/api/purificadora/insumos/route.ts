import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { categoriaGastoSchema } from "@/lib/purificadora/categorias";

// GET /api/purificadora/insumos?companyId=xxx[&all=true]
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const all = searchParams.get("all") === "true";
  const insumos = await prisma.purifInsumo.findMany({
    where: { companyId, ...(all ? {} : { activo: true }) },
    orderBy: [{ activo: "desc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(insumos);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1).max(120),
  unidad: z.string().trim().min(1).max(30).default("pieza"),
  categoria: categoriaGastoSchema.default("FILTROS_INSUMOS"),
});

// POST /api/purificadora/insumos — alta al catálogo de insumos.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  try {
    const insumo = await prisma.purifInsumo.create({ data: { companyId, ...data } });
    return NextResponse.json(insumo, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Ya existe un insumo con ese nombre" }, { status: 409 });
  }
});
