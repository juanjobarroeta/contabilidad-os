import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postVentaPurificadora } from "@/lib/accounting/postings";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/ventas?companyId=xxx&from=&to=&customerId=&estado=&take=&skip=
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const where: Prisma.PurifVentaWhereInput = { companyId };

  const customerId = searchParams.get("customerId")?.trim();
  if (customerId) where.customerId = customerId;

  const estado = searchParams.get("estado");
  if (estado && ["COBRADA", "PENDIENTE", "CANCELADA"].includes(estado)) {
    where.estado = estado as "COBRADA" | "PENDIENTE" | "CANCELADA";
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

  const ventas = await prisma.purifVenta.findMany({
    where,
    include: {
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      items: true,
    },
    orderBy: { fecha: "desc" },
    take,
    skip,
  });
  return NextResponse.json(ventas);
});

const itemSchema = z
  .object({
    productoId: z.string().min(1).optional(),
    descripcion: z.string().trim().min(1).max(200).optional(),
    cantidad: z.number().positive(),
    precioUnitario: z.number().nonnegative().optional(),
    ivaTasa: z.number().min(0).max(0.16).optional(),
    garrafones: z.number().int().min(0).optional(),
  })
  .refine((i) => i.productoId || (i.descripcion && i.precioUnitario !== undefined), {
    message: "Cada partida necesita productoId, o descripcion + precioUnitario",
  });

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1).nullish(),
  fecha: z.string().datetime().optional(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CREDITO"]),
  items: z.array(itemSchema).min(1),
  notas: z.string().trim().max(500).nullish(),
});

// POST /api/purificadora/ventas — registra una venta (mostrador o reparto).
// Atómico: folio consecutivo + venta + partidas + asiento contable
// (DR Caja/Bancos/CxC, CR Ingresos agua purificada [+ CR IVA]).
// Venta a CREDITO nace PENDIENTE (saldo del cliente); el resto, COBRADA.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, customerId, formaPago, items, notas } = parsed.data;
  const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  if (formaPago === "CREDITO" && !customerId) {
    return NextResponse.json(
      { error: "Una venta a crédito necesita cliente" },
      { status: 400 }
    );
  }

  let customerNombre: string | null = null;
  if (customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { companyId: true, razonSocial: true },
    });
    if (!customer || customer.companyId !== companyId) {
      return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
    }
    customerNombre = customer.razonSocial;
  }

  // Resolver productos referenciados y congelar precio/factor de garrafones.
  const productoIds = [...new Set(items.map((i) => i.productoId).filter(Boolean))] as string[];
  const productos = await prisma.purifProducto.findMany({
    where: { id: { in: productoIds }, companyId },
  });
  const productoById = new Map(productos.map((p) => [p.id, p]));
  for (const id of productoIds) {
    if (!productoById.has(id)) {
      return NextResponse.json({ error: "Producto inválido" }, { status: 400 });
    }
  }

  const partidas = items.map((i) => {
    const producto = i.productoId ? productoById.get(i.productoId)! : null;
    const precioUnitario = i.precioUnitario ?? producto?.precio ?? 0;
    const ivaTasa = i.ivaTasa ?? producto?.ivaTasa ?? 0;
    const importe = round2(i.cantidad * precioUnitario);
    const garrafones =
      i.garrafones ?? (producto ? Math.round(i.cantidad * producto.garrafones) : 0);
    return {
      productoId: i.productoId ?? null,
      descripcion: i.descripcion ?? producto?.nombre ?? "Venta",
      cantidad: i.cantidad,
      precioUnitario,
      importe,
      iva: round2(importe * ivaTasa),
      garrafones,
    };
  });

  const subtotal = round2(partidas.reduce((s, p) => s + p.importe, 0));
  const iva = round2(partidas.reduce((s, p) => s + p.iva, 0));
  const total = round2(subtotal + iva);
  const garrafones = partidas.reduce((s, p) => s + p.garrafones, 0);

  if (!(total > 0)) {
    return NextResponse.json({ error: "El total de la venta debe ser mayor a 0" }, { status: 400 });
  }

  // Folio consecutivo por empresa (V-0001, V-0002, …). El unique
  // (companyId, folio) es la red de seguridad ante carreras: reintenta.
  for (let intento = 0; intento < 3; intento++) {
    const last = await prisma.purifVenta.findFirst({
      where: { companyId, folio: { startsWith: "V-" } },
      orderBy: { createdAt: "desc" },
      select: { folio: true },
    });
    const lastNum = last ? parseInt(last.folio.replace("V-", "")) || 0 : 0;
    const folio = `V-${String(lastNum + 1).padStart(4, "0")}`;

    try {
      const venta = await prisma.$transaction(async (tx) => {
        const created = await tx.purifVenta.create({
          data: {
            companyId,
            folio,
            fecha,
            customerId: customerId ?? null,
            formaPago,
            estado: formaPago === "CREDITO" ? "PENDIENTE" : "COBRADA",
            subtotal,
            iva,
            total,
            garrafones,
            notas: notas ?? null,
            items: {
              create: partidas.map(({ iva: _iva, ...p }) => {
                void _iva;
                return p;
              }),
            },
          },
          include: {
            items: true,
            customer: { select: { id: true, razonSocial: true, rfc: true } },
          },
        });

        await postVentaPurificadora(tx, {
          companyId,
          ventaId: created.id,
          descripcion:
            `Venta ${folio}` + (customerNombre ? ` — ${customerNombre}` : " — público general"),
          subtotal,
          iva,
          formaPago,
          fecha,
        });

        return created;
      });
      return NextResponse.json(venta, { status: 201 });
    } catch (e) {
      // P2002 = choque de folio por carrera; cualquier otro error sube.
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
