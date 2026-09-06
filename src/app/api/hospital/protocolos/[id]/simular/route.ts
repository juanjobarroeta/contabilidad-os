/**
 * POST /api/hospital/protocolos/[id]/simular { pagadorId? }
 *
 * Qué costaría el protocolo para un pagador: partidas al precio del convenio
 * (HospTarifa) o de lista —la misma regla que la cotización—, honorarios
 * sugeridos y costo estimado de insumos (ultimoCosto). Sólo lectura.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { errorZod } from "@/lib/hospital/http";
import { simularProtocolo } from "@/lib/hospital/protocolo";

const schema = z.object({ pagadorId: z.string().nullable().optional() });

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return errorZod(parsed.error);

  const p = await prisma.hospProtocolo.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!p) throw new AuthzError(404, "Protocolo no encontrado");

  await requireMembership(p.companyId, undefined, req);
  await requireModule(p.companyId, "HOSPITAL", req);

  const simulacion = await simularProtocolo(prisma, { companyId: p.companyId, protocoloId: id, pagadorId: parsed.data.pagadorId ?? null });
  return NextResponse.json(simulacion);
});
