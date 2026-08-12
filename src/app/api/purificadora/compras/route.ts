import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postCompraPurificadora } from "@/lib/accounting/postings";
import { categoriaGastoSchema } from "@/lib/purificadora/categorias";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const compraInclude = {
  supplier: { select: { id: true, razonSocial: true, rfc: true } },
  invoice: { select: { id: true, uuid: true, folio: true, serie: true, total: true } },
  items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
} as const;

// GET /api/purificadora/compras?companyId=xxx[&from=&to=&estado=&supplierId=]
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const where: Prisma.PurifCompraWhereInput = { companyId };
  const estado = searchParams.get("estado");
  if (estado && ["PAGADA", "PENDIENTE", "CANCELADA"].includes(estado)) {
    where.estado = estado as "PAGADA" | "PENDIENTE" | "CANCELADA";
  }
  const supplierId = searchParams.get("supplierId")?.trim();
  if (supplierId) where.supplierId = supplierId;
  const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : null;
  const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : null;
  if ((from && !isNaN(from.getTime())) || (to && !isNaN(to.getTime()))) {
    where.fecha = {
      ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to && !isNaN(to.getTime()) ? { lte: to } : {}),
    };
  }

  const compras = await prisma.purifCompra.findMany({
    where,
    include: compraInclude,
    orderBy: { fecha: "desc" },
    take: 200,
  });
  return NextResponse.json(compras);
});

const itemSchema = z
  .object({
    insumoId: z.string().min(1).nullish(),
    descripcion: z.string().trim().min(1).max(200).optional(),
    cantidad: z.number().positive(),
    precioUnitario: z.number().nonnegative(),
  })
  .refine((i) => i.insumoId || i.descripcion, {
    message: "Cada partida necesita insumoId o descripción",
  });

const createSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().datetime().optional(),
  supplierId: z.string().min(1).nullish(),
  categoria: categoriaGastoSchema.default("FILTROS_INSUMOS"),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CREDITO"]),
  items: z.array(itemSchema).min(1),
  invoiceId: z.string().min(1).nullish(),
  notas: z.string().trim().max(500).nullish(),
});

// POST /api/purificadora/compras — registra una compra a proveedor.
// Atómica con su asiento (DR 5203 · CR Caja/Bancos o Acreedores en crédito).
// CREDITO nace PENDIENTE (cuenta por pagar al proveedor).
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, supplierId, categoria, formaPago, items, invoiceId, notas } = parsed.data;
  const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

  const { user: actor } = await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  let supplierNombre: string | null = null;
  if (supplierId) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { companyId: true, razonSocial: true },
    });
    if (!supplier || supplier.companyId !== companyId) {
      return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
    }
    supplierNombre = supplier.razonSocial;
  }
  if (invoiceId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { companyId: true, tipo: true },
    });
    if (!invoice || invoice.companyId !== companyId) {
      return NextResponse.json({ error: "Factura inválida" }, { status: 400 });
    }
  }

  const insumoIds = [...new Set(items.map((i) => i.insumoId).filter(Boolean))] as string[];
  const insumos = await prisma.purifInsumo.findMany({
    where: { id: { in: insumoIds }, companyId },
  });
  const insumoById = new Map(insumos.map((i) => [i.id, i]));
  for (const id of insumoIds) {
    if (!insumoById.has(id)) {
      return NextResponse.json({ error: "Insumo inválido" }, { status: 400 });
    }
  }

  const partidas = items.map((i) => {
    const insumo = i.insumoId ? insumoById.get(i.insumoId)! : null;
    return {
      insumoId: i.insumoId ?? null,
      descripcion: i.descripcion ?? insumo?.nombre ?? "Compra",
      cantidad: i.cantidad,
      precioUnitario: i.precioUnitario,
      importe: round2(i.cantidad * i.precioUnitario),
    };
  });
  const total = round2(partidas.reduce((s, p) => s + p.importe, 0));
  if (!(total > 0)) {
    return NextResponse.json({ error: "El total de la compra debe ser mayor a 0" }, { status: 400 });
  }

  // Folio consecutivo C-#### con reintento ante carrera de unicidad.
  for (let intento = 0; intento < 3; intento++) {
    const last = await prisma.purifCompra.findFirst({
      where: { companyId, folio: { startsWith: "C-" } },
      orderBy: { createdAt: "desc" },
      select: { folio: true },
    });
    const folio = `C-${String((last ? parseInt(last.folio.replace("C-", "")) || 0 : 0) + 1).padStart(4, "0")}`;

    try {
      const compra = await prisma.$transaction(async (tx) => {
        const created = await tx.purifCompra.create({
          data: {
            companyId,
            folio,
            fecha,
            supplierId: supplierId ?? null,
            categoria,
            formaPago,
            estado: formaPago === "CREDITO" ? "PENDIENTE" : "PAGADA",
            total,
            notas: notas ?? null,
            invoiceId: invoiceId ?? null,
            items: { create: partidas },
          },
          include: compraInclude,
        });
        await postCompraPurificadora(tx, {
          companyId,
          compraId: created.id,
          descripcion:
            `Compra ${folio}` + (supplierNombre ? ` — ${supplierNombre}` : ""),
          monto: total,
          formaPago,
          fecha,
        });
        return created;
      });
      registrarBitacora({
        companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "compra.crear",
        entidad: "PurifCompra",
        entidadId: compra.id,
        detalle: { folio: compra.folio, total, formaPago, proveedor: supplierNombre },
      });
      return NextResponse.json(compra, { status: 201 });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        intento < 2
      ) {
        continue;
      }
      throw e;
    }
  }
  return NextResponse.json({ error: "No se pudo asignar folio, reintenta" }, { status: 409 });
});
