/**
 * POST /api/construccion/presupuestos/[id]/version
 *
 * Snapshots the current state of an EJECUTADO presupuesto as a version entry.
 * Call this before making significant changes so you have a record of
 * "what the ejecutado looked like before we changed it."
 *
 * Body: { descripcion: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const versionSchema = z.object({ descripcion: z.string().min(1) });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = versionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const pres = await prisma.presupuesto.findUnique({
      where: { id },
      select: { id: true, companyId: true, tipoPresupuesto: true, montoTotal: true },
    });
    if (!pres) throw new AuthzError(404, "Presupuesto no encontrado");
    if (pres.tipoPresupuesto !== "EJECUTADO") {
      return NextResponse.json({ error: "Solo el ejecutado puede tener versiones" }, { status: 422 });
    }

    await requireWriter(pres.companyId, req);
    await requireModule(pres.companyId, "CONSTRUCCION");

    const max = await prisma.presupuestoVersion.aggregate({
      where: { presupuestoId: id },
      _max: { version: true },
    });

    const version = await prisma.presupuestoVersion.create({
      data: {
        presupuestoId: id,
        version: (max._max.version ?? 0) + 1,
        descripcion: parsed.data.descripcion,
        snapshotTotal: pres.montoTotal,
      },
    });

    return NextResponse.json(version, { status: 201 });
  }
);
