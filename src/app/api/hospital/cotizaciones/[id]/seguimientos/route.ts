/**
 * POST /api/hospital/cotizaciones/[id]/seguimientos
 *   { tipo: LLAMADA|WHATSAPP|CORREO|VISITA|NOTA, nota?, resultado?, proximoSeguimiento?: fecha|null }
 *
 * Registra un contacto con el paciente o el médico (sólo se agrega, no se
 * edita) y, si viene, mueve la fecha del próximo seguimiento: null = ya no
 * toca seguir. Una cotización cerrada (convertida, cancelada, perdida) admite
 * notas pero no agenda seguimiento.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { RESULTADOS_SEGUIMIENTO, TIPOS_SEGUIMIENTO } from "@/lib/hospital/cotizacion-crm";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  tipo: z.enum(TIPOS_SEGUIMIENTO),
  nota: z.string().trim().max(4000).optional(),
  resultado: z.enum(RESULTADOS_SEGUIMIENTO).nullable().optional(),
  proximoSeguimiento: fechaSchema.nullable().optional(),
});

const CERRADAS = new Set(["CONVERTIDA", "CANCELADA", "PERDIDA"]);

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  if (!d.nota && !d.resultado) return error("Escribe qué pasó o elige el resultado");

  const c = await prisma.hospCotizacion.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, estado: true } });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");
  const { user } = await requireWriter(c.companyId, req);
  await requireModule(c.companyId, "HOSPITAL", req);
  if (d.proximoSeguimiento && CERRADAS.has(c.estado)) return error(`La cotización está ${c.estado}: ya no se agenda seguimiento`, 409);

  const [seguimiento] = await prisma.$transaction([
    prisma.hospCotizacionSeguimiento.create({
      data: { companyId: c.companyId, cotizacionId: id, userId: user.id, userNombre: user.name ?? user.email ?? null, tipo: d.tipo, resultado: d.resultado ?? null, nota: d.nota || null },
    }),
    ...(d.proximoSeguimiento !== undefined
      ? [prisma.hospCotizacion.update({ where: { id }, data: { proximoSeguimiento: aFecha(d.proximoSeguimiento) }, select: { id: true } })]
      : []),
  ]);

  bitacora(user, req, { companyId: c.companyId, accion: "hospital.cotizacion.seguimiento", entidad: "HospCotizacion", entidadId: id, detalle: { folio: c.folio, tipo: d.tipo, resultado: d.resultado ?? null } });
  return NextResponse.json(seguimiento, { status: 201 });
});
