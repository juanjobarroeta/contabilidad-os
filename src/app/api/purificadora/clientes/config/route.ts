import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// GET /api/purificadora/clientes/config?companyId=xxx
// Precios de garrafón pactados por cliente (los que no tienen fila usan el
// precio de lista de PurifConfig).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const configs = await prisma.purifClienteConfig.findMany({
    where: { companyId },
    include: { customer: { select: { id: true, razonSocial: true } } },
  });
  return NextResponse.json(configs);
});

const putSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  precioGarrafon: z.number().positive(),
});

// PUT /api/purificadora/clientes/config — upsert del precio por cliente.
export const PUT = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, customerId, precioGarrafon } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true },
  });
  if (!customer || customer.companyId !== companyId) {
    return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
  }

  const config = await prisma.purifClienteConfig.upsert({
    where: { companyId_customerId: { companyId, customerId } },
    create: { companyId, customerId, precioGarrafon },
    update: { precioGarrafon },
  });
  return NextResponse.json(config);
});
