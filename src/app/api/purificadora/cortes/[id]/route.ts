import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { corteInclude, corteUpdateSchema, validarLineas } from "@/lib/purificadora/cortes";

type Params = { params: Promise<{ id: string }> };

// GET /api/purificadora/cortes/[id]
export const GET = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const corte = await prisma.purifCorte.findUnique({ where: { id }, include: corteInclude });
  if (!corte) throw new AuthzError(404, "Corte no encontrado");

  await requireMembership(corte.companyId, undefined, req);
  await requireModule(corte.companyId, "PURIFICADORA", req);

  return NextResponse.json(corte);
});

// PUT /api/purificadora/cortes/[id] — reemplaza las líneas (sólo BORRADOR).
export const PUT = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = corteUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const corte = await prisma.purifCorte.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!corte) throw new AuthzError(404, "Corte no encontrado");

  await requireWriter(corte.companyId, req);
  await requireModule(corte.companyId, "PURIFICADORA", req);

  if (corte.estado !== "BORRADOR") {
    return NextResponse.json(
      { error: "El corte ya está confirmado; ajusta las ventas/gastos generados" },
      { status: 422 }
    );
  }

  const { rutas, empresas, gastos, ...resto } = parsed.data;
  const lineasError = await validarLineas(corte.companyId, { rutas, empresas });
  if (lineasError) return NextResponse.json({ error: lineasError }, { status: 400 });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.purifCorteRuta.deleteMany({ where: { corteId: id } });
    await tx.purifCorteEmpresa.deleteMany({ where: { corteId: id } });
    await tx.purifCorteGasto.deleteMany({ where: { corteId: id } });
    return tx.purifCorte.update({
      where: { id },
      data: {
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
  });
  return NextResponse.json(updated);
});

// DELETE /api/purificadora/cortes/[id] — sólo BORRADOR.
export const DELETE = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const corte = await prisma.purifCorte.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!corte) throw new AuthzError(404, "Corte no encontrado");

  await requireWriter(corte.companyId, req);
  await requireModule(corte.companyId, "PURIFICADORA", req);

  if (corte.estado !== "BORRADOR") {
    return NextResponse.json(
      { error: "No se puede borrar un corte confirmado" },
      { status: 422 }
    );
  }

  await prisma.purifCorte.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
