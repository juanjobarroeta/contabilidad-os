import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const createProyectoSchema = z.object({
  companyId: z.string().min(1),
  codigo: z.string().min(1).max(40),
  nombre: z.string().min(1),
  descripcion: z.string().optional(),
  ubicacion: z.string().optional(),
  tipo: z.enum(["GOBIERNO", "PRIVADO", "MIXTO"]).default("PRIVADO"),
  customerId: z.string().optional(),
  numeroContrato: z.string().optional(),
  numeroLicitacion: z.string().optional(),
  modalidadContrato: z.string().optional(),
  dependenciaCliente: z.string().optional(),
  fechaInicio: z.string().datetime().optional(),
  fechaFinPlan: z.string().datetime().optional(),
  montoContratado: z.number().positive().optional(),
  anticipoPorc: z.number().min(0).max(100).optional(),
  retencionPorc: z.number().min(0).max(100).optional(),
});

// GET /api/construccion/proyectos?companyId=xxx&estado=EN_EJECUCION
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const estado = searchParams.get("estado");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const proyectos = await prisma.proyecto.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as never } : {}),
    },
    include: {
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { presupuestos: true, estimaciones: true, solicitudesCompra: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(proyectos);
});

// POST /api/construccion/proyectos
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json();
  const parsed = createProyectoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  await requireWriter(data.companyId, req);
  await requireModule(data.companyId, "CONSTRUCCION");

  // Validate optional customer belongs to the same company
  if (data.customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: data.customerId },
      select: { companyId: true },
    });
    if (!customer || customer.companyId !== data.companyId) {
      return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
    }
  }

  try {
    const proyecto = await prisma.proyecto.create({
      data: {
        companyId: data.companyId,
        codigo: data.codigo,
        nombre: data.nombre,
        descripcion: data.descripcion,
        ubicacion: data.ubicacion,
        tipo: data.tipo,
        customerId: data.customerId,
        numeroContrato: data.numeroContrato,
        numeroLicitacion: data.numeroLicitacion,
        modalidadContrato: data.modalidadContrato,
        dependenciaCliente: data.dependenciaCliente,
        fechaInicio: data.fechaInicio ? new Date(data.fechaInicio) : null,
        fechaFinPlan: data.fechaFinPlan ? new Date(data.fechaFinPlan) : null,
        montoContratado: data.montoContratado,
        anticipoPorc: data.anticipoPorc,
        retencionPorc: data.retencionPorc,
      },
    });
    return NextResponse.json(proyecto, { status: 201 });
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe un proyecto con ese código en esta empresa" },
        { status: 409 }
      );
    }
    throw e;
  }
});
