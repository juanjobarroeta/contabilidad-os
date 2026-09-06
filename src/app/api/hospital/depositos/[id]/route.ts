/**
 * PATCH /api/hospital/depositos/[id] { estado: APLICADO|DEVUELTO|CANCELADO, fecha? } → depósito
 *
 * Sólo desde RECIBIDO. Con la contabilidad activa, la etapa deja su asiento
 * (APLICADO: ANTICIPOS_PACIENTES contra CLIENTES; DEVUELTO: contra CAJA/BANCOS;
 * CANCELADO: reversa del recibido si ya estaba en el libro). Ver depositos.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, errorZod, fechaSchema } from "@/lib/hospital/http";
import { ESTADOS_DESTINO, cambiarEstadoDeposito, depositoResumen } from "@/lib/hospital/depositos";

const schema = z.object({
  estado: z.enum(ESTADOS_DESTINO),
  fecha: fechaSchema.nullable().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const dep = await prisma.hospDeposito.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, episodio: { select: { folio: true } } } });
  if (!dep) throw new AuthzError(404, "Depósito no encontrado");

  const { user } = await requireWriter(dep.companyId, req);
  await requireModule(dep.companyId, "HOSPITAL", req);

  const actualizado = await cambiarEstadoDeposito(prisma, {
    companyId: dep.companyId,
    depositoId: dep.id,
    estado: parsed.data.estado,
    fecha: aFecha(parsed.data.fecha),
  });

  bitacora(user, req, {
    companyId: dep.companyId,
    accion: "hospital.deposito.estado",
    entidad: "HospDeposito",
    entidadId: dep.id,
    detalle: { folio: dep.episodio.folio, de: dep.estado, a: actualizado.estado, monto: Number(actualizado.monto), asentado: !!actualizado.asientoAt },
  });
  return NextResponse.json(depositoResumen(actualizado));
});
