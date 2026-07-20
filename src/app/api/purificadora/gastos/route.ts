import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postGastoPurificadora } from "@/lib/accounting/postings";

const CATEGORIAS = [
  "AGUA_CRUDA",
  "ELECTRICIDAD",
  "FILTROS_INSUMOS",
  "MANTENIMIENTO",
  "SUELDOS",
  "RENTA",
  "COMBUSTIBLE",
  "OTRO",
] as const;

// GET /api/purificadora/gastos?companyId=xxx&from=&to=&categoria=&take=&skip=
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const where: Prisma.PurifGastoWhereInput = { companyId };

  const categoria = searchParams.get("categoria");
  if (categoria && (CATEGORIAS as readonly string[]).includes(categoria)) {
    where.categoria = categoria as (typeof CATEGORIAS)[number];
  }

  const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : null;
  const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : null;
  if ((from && !isNaN(from.getTime())) || (to && !isNaN(to.getTime()))) {
    where.fecha = {
      ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to && !isNaN(to.getTime()) ? { lte: to } : {}),
    };
  }

  const take = Math.min(parseInt(searchParams.get("take") ?? "50") || 50, 200);
  const skip = Math.max(0, parseInt(searchParams.get("skip") ?? "0") || 0);

  const gastos = await prisma.purifGasto.findMany({
    where,
    include: { supplier: { select: { id: true, razonSocial: true, rfc: true } } },
    orderBy: { fecha: "desc" },
    take,
    skip,
  });
  return NextResponse.json(gastos);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().datetime().optional(),
  categoria: z.enum(CATEGORIAS),
  descripcion: z.string().trim().min(1).max(200),
  monto: z.number().positive(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CREDITO"]).default("EFECTIVO"),
  supplierId: z.string().min(1).nullish(),
  notas: z.string().trim().max(500).nullish(),
});

// POST /api/purificadora/gastos — registra un gasto de operación.
// Atómico con su asiento: DR 5203 Gastos de operación purificadora /
// CR Caja-Bancos (contado) o CR Acreedores diversos (CREDITO).
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, categoria, descripcion, monto, formaPago, supplierId, notas } = parsed.data;
  const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  if (supplierId) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { companyId: true },
    });
    if (!supplier || supplier.companyId !== companyId) {
      return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
    }
  }

  const gasto = await prisma.$transaction(async (tx) => {
    const created = await tx.purifGasto.create({
      data: {
        companyId,
        fecha,
        categoria,
        descripcion,
        monto,
        formaPago,
        supplierId: supplierId ?? null,
        notas: notas ?? null,
      },
      include: { supplier: { select: { id: true, razonSocial: true, rfc: true } } },
    });

    await postGastoPurificadora(tx, {
      companyId,
      gastoId: created.id,
      descripcion: `Gasto purificadora — ${descripcion}`,
      monto,
      formaPago,
      fecha,
    });

    return created;
  });

  return NextResponse.json(gasto, { status: 201 });
});
