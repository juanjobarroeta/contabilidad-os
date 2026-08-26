import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { buildPartidasAndOffers } from "@/lib/construccion/requisicion-offers";
import { moneyPush, notificarConstruccion } from "@/lib/construccion/push";

const partidaSchema = z.object({
  insumoId: z.string().optional(),
  descripcion: z.string().min(1),
  unidad: z.string().max(20).nullable().optional(), // TON, PALLET, m3, kg, pza
  cantidad: z.number().positive(),
  precioUnitario: z.number().nonnegative().optional(),
  presupuestoPartidaId: z.string().optional(),
});

// Inline supplier offers (one cotización each). Lines reference partidas by
// their position in the partidas array.
const offerSchema = z.object({
  supplierId: z.string().min(1).nullable().optional(),
  supplierNombre: z.string().min(1).max(120),
  tieneCredito: z.boolean().optional(),
  diasCredito: z.number().int().min(0).max(365).nullable().optional(),
  diasEntrega: z.number().int().min(0).max(365).nullable().optional(),
  lineas: z
    .array(
      z.object({
        partidaIndex: z.number().int().nonnegative(),
        precioUnitario: z.number().nonnegative(),
      })
    )
    .default([]),
});

const createSolicitudSchema = z.object({
  companyId: z.string().min(1),
  folio: z.string().min(1),
  proyectoId: z.string().optional(),
  supplierId: z.string().optional(),
  notas: z.string().optional(),
  // Header fields matching the partner's Excel template:
  fechaEntrega: z.string().nullable().optional(), // ISO date string
  formaPago: z.enum(["CREDITO", "CONTADO"]).nullable().optional(),
  // BORRADOR = draft (shared, not yet sent for authorization); default
  // PENDIENTE keeps existing callers submitting straight to authorization.
  estado: z.enum(["BORRADOR", "PENDIENTE"]).optional(),
  partidas: z.array(partidaSchema).min(1),
  offers: z.array(offerSchema).optional(),
});

// GET /api/construccion/solicitudes-compra?companyId=xxx&estado=PENDIENTE
//   [&withCotizaciones=1]  → embeds partidas + cotizaciones (lines, credit,
//   delivery, per-line award) so the "Compras por autorizar" dashboard can
//   render the full supplier comparison without an N+1 of detail calls.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const estado = searchParams.get("estado");
  const withCotizaciones = searchParams.get("withCotizaciones") === "1";
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const solicitudes = await prisma.solicitudCompra.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as never } : {}),
    },
    include: {
      proyecto: { select: { id: true, codigo: true, nombre: true } },
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { partidas: true, cotizaciones: true } },
      // Lightweight cotización totals so the list can show an estimated value
      // (cheapest oferta) before adjudication, when solicitud.total is still 0.
      // Overridden by the full cotizaciones select when withCotizaciones=1.
      cotizaciones: { select: { total: true } },
      ...(withCotizaciones
        ? {
            partidas: {
              select: {
                id: true,
                insumoId: true,
                descripcion: true,
                unidad: true,
                cantidad: true,
                cotizacionGanadoraId: true,
              },
            },
            cotizaciones: {
              select: {
                id: true,
                supplierId: true,
                supplierNombre: true,
                tieneCredito: true,
                diasCredito: true,
                diasEntrega: true,
                total: true,
                partidas: {
                  select: { solicitudPartidaId: true, precioUnitario: true, importe: true },
                },
              },
            },
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(solicitudes);
});

// POST /api/construccion/solicitudes-compra
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json();
  const parsed = createSolicitudSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const { user } = await requireWriter(data.companyId, req);
  await requireModule(data.companyId, "CONSTRUCCION");

  // Optional cross-checks: project + supplier belong to the same company
  if (data.proyectoId) {
    const p = await prisma.proyecto.findUnique({
      where: { id: data.proyectoId },
      select: { companyId: true },
    });
    if (!p || p.companyId !== data.companyId) {
      return NextResponse.json({ error: "Proyecto inválido" }, { status: 400 });
    }
  }
  if (data.supplierId) {
    const s = await prisma.supplier.findUnique({
      where: { id: data.supplierId },
      select: { companyId: true },
    });
    if (!s || s.companyId !== data.companyId) {
      return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
    }
  }

  try {
    const solicitud = await prisma.$transaction(async (tx) => {
      const header = await tx.solicitudCompra.create({
        data: {
          companyId: data.companyId,
          folio: data.folio,
          proyectoId: data.proyectoId,
          supplierId: data.supplierId,
          notas: data.notas,
          fechaEntrega: data.fechaEntrega ? new Date(data.fechaEntrega) : null,
          formaPago: data.formaPago ?? null,
          estado: data.estado ?? "PENDIENTE",
          creadaPorId: user.id,
          total: 0,
        },
      });
      // Create partidas (in order) + any inline offers, then persist the total.
      const { total } = await buildPartidasAndOffers(
        tx,
        header.id,
        data.partidas,
        data.offers ?? []
      );
      await tx.solicitudCompra.update({ where: { id: header.id }, data: { total } });
      return tx.solicitudCompra.findUnique({
        where: { id: header.id },
        include: { partidas: true, cotizaciones: { include: { partidas: true } } },
      });
    });
    // Enviada directo a autorización → avisar a quienes autorizan (admins y
    // contabilidad), sin el propio autor. Fire-and-forget: un push caído no
    // debe tirar la creación.
    if (solicitud && solicitud.estado === "PENDIENTE") {
      void notificarConstruccion({
        companyId: data.companyId,
        destinos: ["ADMIN", "CONTABILIDAD"],
        excludeUserId: user.id,
        payload: {
          title: `Nueva requisición ${solicitud.folio}`,
          body: `${moneyPush(solicitud.total)} — por autorizar`,
          url: "/compras-por-autorizar",
          tag: `solicitud-${solicitud.id}`,
        },
      });
    }
    return NextResponse.json(solicitud, { status: 201 });
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe una solicitud con ese folio" },
        { status: 409 }
      );
    }
    throw e;
  }
});
