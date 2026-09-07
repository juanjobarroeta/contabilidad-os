/**
 * GET  /api/salameria/pedidos?companyId=... [&estado=][&origen=][&q=]
 * POST /api/salameria/pedidos      (alta desde el mostrador)
 *
 * El pedido, venga de donde venga. El listado NO incluye los CARRITO: son
 * carritos vivos de la tienda, no pedidos, y meterlos en la bandeja de trabajo
 * llenaría la pantalla de gente que todavía está viendo qué comprar.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { conFolioUnico, siguienteFolio } from "@/lib/salameria/folio";
import { recalcularPedido, resolverPartidas } from "@/lib/salameria/pedidos";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const estado = searchParams.get("estado");
  const origen = searchParams.get("origen");
  const q = searchParams.get("q");

  const pedidos = await prisma.salPedido.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as never } : { estado: { not: "CARRITO" } }),
      ...(origen ? { origen: origen as never } : {}),
      ...(q
        ? {
            OR: [
              { folio: { contains: q, mode: "insensitive" as const } },
              { envioNombre: { contains: q, mode: "insensitive" as const } },
              { cuenta: { email: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    include: {
      cuenta: { select: { id: true, email: true, nombre: true } },
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { partidas: true } },
    },
    take: 200,
  });

  return NextResponse.json(pedidos);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  origen: z.enum(["MOSTRADOR", "WHATSAPP", "TELEFONO"]).default("MOSTRADOR"),
  cuentaId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  recogeEnTienda: z.boolean().default(true),
  envioNombre: z.string().max(120).nullable().optional(),
  envioTelefono: z.string().max(30).nullable().optional(),
  envioCalle: z.string().max(160).nullable().optional(),
  envioColonia: z.string().max(120).nullable().optional(),
  envioCiudad: z.string().max(120).nullable().optional(),
  envioEstado: z.string().max(80).nullable().optional(),
  envioCp: z.string().max(10).nullable().optional(),
  envioReferencia: z.string().max(300).nullable().optional(),
  descuento: z.number().min(0).default(0),
  notas: z.string().max(2000).nullable().optional(),
  partidas: z
    .array(
      z.object({
        productoId: z.string().min(1),
        cantidad: z.number().positive(),
        /** Precio a mano: pisa el de la lista (autorización del mostrador). */
        precio: z.number().min(0).optional(),
      })
    )
    .min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, partidas, cuentaId, ...cabecera } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  // La lista del cliente decide el precio; sin cuenta, el del mostrador es el
  // público. Se valida que la cuenta sea de esta empresa antes de usar su lista.
  const cuenta = cuentaId
    ? await prisma.salCuenta.findFirst({
        where: { id: cuentaId, companyId },
        select: { id: true, listaId: true, customerId: true },
      })
    : null;
  if (cuentaId && !cuenta) {
    return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  }

  const resueltas = await resolverPartidas(prisma, {
    companyId,
    listaId: cuenta?.listaId ?? null,
    partidas: partidas.map((p) => ({ productoId: p.productoId, cantidad: p.cantidad })),
  });

  // Un precio capturado a mano sustituye al de la lista, pero un producto sin
  // precio de lista Y sin precio capturado sigue siendo un error: no se
  // inventa un cero.
  const manual = new Map(
    partidas.filter((p) => p.precio !== undefined).map((p) => [p.productoId, p.precio!])
  );
  const bloqueantes = resueltas.filter(
    (r) => r.problema && !(r.problema === "Sin precio en la lista" && manual.has(r.productoId))
  );
  if (bloqueantes.length) {
    return NextResponse.json(
      {
        error: "Hay partidas que no se pueden vender",
        partidas: bloqueantes.map((r) => ({ productoId: r.productoId, problema: r.problema })),
      },
      { status: 409 }
    );
  }

  const pedido = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "pedido");
      const creado = await tx.salPedido.create({
        data: {
          companyId,
          folio,
          estado: "PENDIENTE_PAGO",
          cuentaId: cuenta?.id ?? null,
          customerId: cabecera.customerId ?? cuenta?.customerId ?? null,
          ...cabecera,
          partidas: {
            create: resueltas.map((r) => {
              const precio = manual.get(r.productoId) ?? r.precio;
              return {
                productoId: r.productoId,
                cantidad: r.cantidad,
                precio,
                ivaTasa: r.ivaTasa,
                importe: Math.round(r.cantidad * precio * 100) / 100,
                nombreCongelado: r.nombre,
                esPreventa: r.esPreventa,
              };
            }),
          },
        },
      });
      return recalcularPedido(tx, creado.id);
    })
  );

  return NextResponse.json(pedido, { status: 201 });
});
