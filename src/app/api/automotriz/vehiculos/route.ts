/**
 * GET  /api/automotriz/vehiculos?companyId=…&estado=…&tipo=…
 * POST /api/automotriz/vehiculos
 *
 * Alta y listado de unidades. El alta NO postea al ledger: la unidad nace
 * EN_TRANSITO y el inventario se postea al recibirla (POST …/[id]/recibir),
 * que es la transición de la máquina de estados que garantiza idempotencia.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const estado = searchParams.get("estado");
  const tipo = searchParams.get("tipo");

  const vehiculos = await prisma.vehiculo.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as never } : {}),
      ...(tipo ? { tipo: tipo as never } : {}),
    },
    include: {
      cliente: { select: { id: true, razonSocial: true, rfc: true } },
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
      costos: { select: { tipo: true, monto: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    vehiculos.map(({ costos, ...v }) => ({
      ...v,
      costosTotal: costos.reduce((s, c) => s + c.monto, 0),
    }))
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  vin: z
    .string()
    .min(11)
    .max(17)
    .transform((v) => v.trim().toUpperCase()),
  marca: z.string().min(1).max(60),
  modelo: z.string().min(1).max(60),
  version: z.string().max(80).nullable().optional(),
  anio: z.number().int().min(1990).max(2100),
  color: z.string().max(40).nullable().optional(),
  numeroEconomico: z.string().max(20).nullable().optional(),
  tipo: z.enum(["NUEVO", "SEMINUEVO"]).default("NUEVO"),
  kilometraje: z.number().int().min(0).nullable().optional(),
  costoCompra: z.number().min(0).default(0),
  compraInvoiceId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  planPisoTasaAnual: z.number().min(0).max(2).nullable().optional(),
  precioLista: z.number().min(0).nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, compraInvoiceId, supplierId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const dup = await prisma.vehiculo.findUnique({
    where: { companyId_vin: { companyId, vin: data.vin } },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json(
      { error: `Ya existe una unidad con VIN ${data.vin}` },
      { status: 409 }
    );
  }

  // FKs canónicos: verificar que pertenecen a la misma empresa (fail-closed).
  if (compraInvoiceId) {
    const inv = await prisma.invoice.findUnique({
      where: { id: compraInvoiceId },
      select: { companyId: true },
    });
    if (!inv || inv.companyId !== companyId) {
      return NextResponse.json({ error: "compraInvoiceId inválido" }, { status: 400 });
    }
  }
  if (supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { companyId: true },
    });
    if (!sup || sup.companyId !== companyId) {
      return NextResponse.json({ error: "supplierId inválido" }, { status: 400 });
    }
  }

  const vehiculo = await prisma.vehiculo.create({
    data: { companyId, compraInvoiceId, supplierId, ...data },
  });
  return NextResponse.json(vehiculo, { status: 201 });
});
