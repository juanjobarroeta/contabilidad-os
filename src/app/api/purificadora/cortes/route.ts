import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import {
  corteCreateSchema,
  corteInclude,
  parseFechaCorte,
  validarLineas,
} from "@/lib/purificadora/cortes";

// GET /api/purificadora/cortes?companyId=xxx[&from=&to=&estado=]
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const estado = searchParams.get("estado");
  const from = searchParams.get("from") ? parseFechaCorte(searchParams.get("from")!) : null;
  const to = searchParams.get("to") ? parseFechaCorte(searchParams.get("to")!) : null;

  const cortes = await prisma.purifCorte.findMany({
    where: {
      companyId,
      ...(estado === "BORRADOR" || estado === "CONFIRMADO" ? { estado } : {}),
      ...(from || to
        ? { fecha: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    include: corteInclude,
    orderBy: { fecha: "desc" },
    take: 60,
  });
  return NextResponse.json(cortes);
});

// POST /api/purificadora/cortes — crea el corte del día en BORRADOR.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = corteCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, fecha: fechaStr, rutas, empresas, gastos, ...resto } = parsed.data;
  const fecha = parseFechaCorte(fechaStr);
  if (!fecha) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const lineasError = await validarLineas(companyId, { rutas, empresas });
  if (lineasError) return NextResponse.json({ error: lineasError }, { status: 400 });

  try {
    const corte = await prisma.purifCorte.create({
      data: {
        companyId,
        fecha,
        cortesiasGarrafones: resto.cortesiasGarrafones,
        cortesiasImporte: resto.cortesiasImporte,
        notas: resto.notas ?? null,
        rutas: { create: rutas },
        empresas: {
          create: empresas.map((e) => ({
            customerId: e.customerId,
            sucursalId: e.sucursalId ?? null,
            garrafones: e.garrafones,
          })),
        },
        gastos: { create: gastos },
      },
      include: corteInclude,
    });
    return NextResponse.json(corte, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Ya existe un corte para ese día — ábrelo para editarlo" },
      { status: 409 }
    );
  }
});
