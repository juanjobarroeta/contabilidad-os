/**
 * PATCH /api/hospital/afiliaciones/[id] { descripcion?, adquirente?, tasa?, activa? }
 *
 * El `numero` no se edita: es la llave con la que el adquirente imprime su
 * estado de cuenta y con la que ya están casados los cobros capturados. Una
 * afiliación que cambió se da de baja y se da de alta la nueva.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { afiliacionResumen } from "@/lib/hospital/cobros";

const schema = z.object({
  descripcion: z.string().trim().max(120).nullable().optional(),
  adquirente: z.string().trim().max(60).nullable().optional(),
  tasa: z.number().min(0).max(0.2).nullable().optional(),
  liquidaEnBruto: z.boolean().optional(),
  activa: z.boolean().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const af = await prisma.hospAfiliacion.findUnique({ where: { id }, select: { id: true, companyId: true, numero: true } });
  if (!af) throw new AuthzError(404, "Afiliación no encontrada");

  const { user } = await requireWriter(af.companyId, req);
  await requireModule(af.companyId, "HOSPITAL", req);

  const actualizada = await prisma.hospAfiliacion.update({
    where: { id: af.id },
    data: parsed.data,
    include: { _count: { select: { cobros: true } } },
  });

  bitacora(user, req, {
    companyId: af.companyId,
    accion: "hospital.afiliacion.editar",
    entidad: "HospAfiliacion",
    entidadId: af.id,
    detalle: { numero: af.numero, cambios: parsed.data },
  });
  return NextResponse.json(afiliacionResumen(actualizada));
});
