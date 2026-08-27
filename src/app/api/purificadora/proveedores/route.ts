import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/proveedores?companyId=xxx
//
// Vista unificada por RFC de los proveedores del negocio:
//   - Los CFDIs RECIBIDOS (Invoice tipo EGRESO; el emisor vive como fila de
//     Customer, así los importa el sync del SAT) agregados por emisor.
//   - Los Supplier canónicos dados de alta, con sus compras del módulo y el
//     saldo por pagar (compras a crédito PENDIENTES).
// Un RFC con CFDIs pero sin Supplier aparece con supplierId=null para que la
// UI ofrezca darlo de alta con un clic.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const [suppliers, cfdisPorEmisor, comprasAgg, pendientesAgg] = await Promise.all([
    prisma.supplier.findMany({
      where: { companyId },
      select: { id: true, rfc: true, razonSocial: true, email: true, clabe: true },
    }),
    prisma.invoice.groupBy({
      by: ["customerId"],
      where: {
        companyId,
        tipo: "EGRESO",
        status: { not: "CANCELLED" },
        customerId: { not: null },
      },
      _sum: { total: true },
      _count: true,
      _max: { fecha: true },
    }),
    prisma.purifCompra.groupBy({
      by: ["supplierId"],
      where: { companyId, estado: { not: "CANCELADA" }, supplierId: { not: null } },
      _sum: { total: true },
      _count: true,
      _max: { fecha: true },
    }),
    prisma.purifCompra.groupBy({
      by: ["supplierId"],
      where: { companyId, estado: "PENDIENTE", supplierId: { not: null } },
      _sum: { total: true },
    }),
  ]);

  // Nombres/RFC de los emisores de CFDIs (viven como Customer).
  const emisorIds = cfdisPorEmisor.map((c) => c.customerId).filter(Boolean) as string[];
  const emisores = emisorIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: emisorIds } },
        select: { id: true, rfc: true, razonSocial: true },
      })
    : [];
  const emisorById = new Map(emisores.map((e) => [e.id, e]));
  const comprasBySupplier = new Map(comprasAgg.map((c) => [c.supplierId, c]));
  const pendienteBySupplier = new Map(
    pendientesAgg.map((p) => [p.supplierId, round2(Number(p._sum.total ?? 0))])
  );

  type Row = {
    rfc: string;
    nombre: string;
    supplierId: string | null;
    email: string | null;
    cfdiFacturas: number;
    cfdiTotal: number;
    ultimaFactura: Date | null;
    compras: number;
    comprasTotal: number;
    saldoPorPagar: number;
  };
  const porRfc = new Map<string, Row>();
  const rowFor = (rfc: string, nombre: string): Row => {
    let r = porRfc.get(rfc);
    if (!r) {
      r = {
        rfc,
        nombre,
        supplierId: null,
        email: null,
        cfdiFacturas: 0,
        cfdiTotal: 0,
        ultimaFactura: null,
        compras: 0,
        comprasTotal: 0,
        saldoPorPagar: 0,
      };
      porRfc.set(rfc, r);
    }
    return r;
  };

  for (const s of suppliers) {
    const row = rowFor(s.rfc, s.razonSocial);
    row.supplierId = s.id;
    row.email = s.email;
    const compras = comprasBySupplier.get(s.id);
    if (compras) {
      row.compras = compras._count;
      row.comprasTotal = round2(Number(compras._sum.total ?? 0));
      row.ultimaFactura = compras._max.fecha ?? row.ultimaFactura;
    }
    row.saldoPorPagar = pendienteBySupplier.get(s.id) ?? 0;
  }

  for (const c of cfdisPorEmisor) {
    const emisor = emisorById.get(c.customerId!);
    if (!emisor) continue;
    const row = rowFor(emisor.rfc, emisor.razonSocial);
    row.cfdiFacturas = c._count;
    row.cfdiTotal = round2(Number(c._sum.total ?? 0));
    const f = c._max.fecha;
    if (f && (!row.ultimaFactura || f > row.ultimaFactura)) row.ultimaFactura = f;
  }

  const rows = [...porRfc.values()].sort(
    (a, b) => b.cfdiTotal + b.comprasTotal - (a.cfdiTotal + a.comprasTotal)
  );
  return NextResponse.json(rows);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  rfc: z.string().trim().min(12).max(13),
  razonSocial: z.string().trim().min(1).max(200),
  email: z.string().email().nullish(),
});

// POST /api/purificadora/proveedores — alta del Supplier canónico (p. ej.
// desde un emisor de CFDIs recibidos, con un clic).
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, rfc, razonSocial, email } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  try {
    const supplier = await prisma.supplier.create({
      data: {
        companyId,
        rfc: rfc.toUpperCase(),
        razonSocial,
        email: email ?? null,
      },
    });
    return NextResponse.json(supplier, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Ya existe un proveedor con ese RFC" }, { status: 409 });
  }
});
