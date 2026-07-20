import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// GET /api/purificadora/sucursales?companyId=xxx[&customerId=][&all=true]
// Sucursales (puntos de entrega) de los clientes-empresa.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customerId = searchParams.get("customerId")?.trim();
  const all = searchParams.get("all") === "true";

  const sucursales = await prisma.purifSucursal.findMany({
    where: {
      companyId,
      ...(customerId ? { customerId } : {}),
      ...(all ? {} : { activo: true }),
    },
    include: { customer: { select: { id: true, razonSocial: true } } },
    orderBy: [{ customerId: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(sucursales);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  nombre: z.string().trim().min(1).max(120),
});

// POST /api/purificadora/sucursales
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, customerId, nombre } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true },
  });
  if (!customer || customer.companyId !== companyId) {
    return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
  }

  try {
    const sucursal = await prisma.purifSucursal.create({
      data: { companyId, customerId, nombre },
    });
    return NextResponse.json(sucursal, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Ese cliente ya tiene una sucursal con ese nombre" },
      { status: 409 }
    );
  }
});
