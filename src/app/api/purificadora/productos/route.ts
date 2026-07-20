import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// GET /api/purificadora/productos?companyId=xxx&all=true
// Lista el catálogo de productos (recarga de garrafón, garrafón nuevo, botella,
// hielo, …). Por default sólo activos; ?all=true incluye los desactivados.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const all = searchParams.get("all") === "true";
  // ?ventanilla=true → sólo el menú del POS de mostrador.
  const soloVentanilla = searchParams.get("ventanilla") === "true";
  const productos = await prisma.purifProducto.findMany({
    where: {
      companyId,
      ...(all ? {} : { activo: true }),
      ...(soloVentanilla ? { enVentanilla: true } : {}),
    },
    orderBy: [{ activo: "desc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(productos);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1).max(120),
  precio: z.number().nonnegative(),
  garrafones: z.number().int().min(0).default(1),
  ivaTasa: z.number().min(0).max(0.16).default(0),
  enVentanilla: z.boolean().default(true),
});

// POST /api/purificadora/productos — alta de producto.
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
    const producto = await prisma.purifProducto.create({ data: { companyId, ...data } });
    return NextResponse.json(producto, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Ya existe un producto con ese nombre" },
      { status: 409 }
    );
  }
});
