import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const partidaSchema = z.object({
  insumoId: z.string().optional(),
  descripcion: z.string().min(1),
  cantidad: z.number().positive(),
  precioUnitario: z.number().nonnegative(),
});

const createSolicitudSchema = z.object({
  companyId: z.string().min(1),
  folio: z.string().min(1),
  proyectoId: z.string().optional(),
  supplierId: z.string().optional(),
  notas: z.string().optional(),
  partidas: z.array(partidaSchema).min(1),
});

// GET /api/construccion/solicitudes-compra?companyId=xxx&estado=PENDIENTE
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const estado = searchParams.get("estado");
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
      partidas: true,
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

  await requireWriter(data.companyId, req);
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

  // Compute total server-side — never trust the client
  const partidasWithImporte = data.partidas.map((p) => ({
    ...p,
    importe: Number((p.cantidad * p.precioUnitario).toFixed(2)),
  }));
  const total = Number(
    partidasWithImporte.reduce((acc, p) => acc + p.importe, 0).toFixed(2)
  );

  try {
    const solicitud = await prisma.solicitudCompra.create({
      data: {
        companyId: data.companyId,
        folio: data.folio,
        proyectoId: data.proyectoId,
        supplierId: data.supplierId,
        notas: data.notas,
        total,
        partidas: {
          create: partidasWithImporte,
        },
      },
      include: { partidas: true },
    });
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
