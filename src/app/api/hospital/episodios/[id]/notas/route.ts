/**
 * POST /api/hospital/episodios/[id]/notas — nota del expediente.
 *
 * Inmutable (NOM-004-SSA3-2012): no hay PATCH ni DELETE. Una corrección es
 * una nota nueva con `reemplazaId`; la anterior queda como versión superada.
 * El autor es el usuario autenticado, nunca un nombre que mande el cliente.
 * `secciones` se valida contra la plantilla del tipo (lib/hospital/notas.ts);
 * las notas médicas llevan cédula (del HospMedico o `autorCedula`); el hub
 * calcula `hash` y `selloAt` (firma del sistema, NOM-024).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { TIPOS_NOTA, crearNota } from "@/lib/hospital/notas";

const schema = z.object({
  tipo: z.enum(TIPOS_NOTA),
  texto: z.string().min(1).max(20000),
  secciones: z.record(z.string(), z.unknown()).nullable().optional(),
  fecha: fechaSchema.nullable().optional(),
  medicoId: z.string().nullable().optional(),
  autorCedula: z.string().max(20).nullable().optional(),
  reemplazaId: z.string().nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true, medicoId: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  const nota = await crearNota(prisma, {
    companyId: ep.companyId,
    episodioId: ep.id,
    tipo: d.tipo,
    texto: d.texto,
    secciones: d.secciones ?? null,
    fecha: aFecha(d.fecha),
    medicoId: d.medicoId ?? null,
    autorCedula: d.autorCedula ?? null,
    reemplazaId: d.reemplazaId ?? null,
    usuario: usuarioDe(user),
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.nota.crear",
    entidad: "HospNota",
    entidadId: nota.id,
    detalle: { folio: ep.folio, tipo: d.tipo, reemplazaId: d.reemplazaId ?? null, hash: nota.hash },
  });

  return NextResponse.json({ ...nota, reemplazadaPor: null, hashVerificado: true }, { status: 201 });
});
