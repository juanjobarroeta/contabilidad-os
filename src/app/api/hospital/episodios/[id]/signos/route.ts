/**
 * POST /api/hospital/episodios/[id]/signos — una toma de signos a pie de cama.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";

const entero = (max: number) => z.number().int().min(0).max(max).nullable().optional();

const schema = z
  .object({
    taSistolica: entero(300),
    taDiastolica: entero(200),
    fc: entero(300),
    fr: entero(100),
    temperatura: z.number().min(25).max(45).nullable().optional(),
    spo2: entero(100),
    glucosa: entero(1000),
    peso: z.number().min(0).max(500).nullable().optional(),
    talla: z.number().min(0).max(300).nullable().optional(),
    dolor: entero(10),
    nota: z.string().max(500).nullable().optional(),
    fecha: fechaSchema.nullable().optional(),
  })
  .refine(
    (s) => [s.taSistolica, s.taDiastolica, s.fc, s.fr, s.temperatura, s.spo2, s.glucosa, s.peso, s.talla, s.dolor].some((v) => v != null),
    { message: "Captura al menos un signo" }
  );

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { fecha, ...d } = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  const usuario = usuarioDe(user);
  const signos = await prisma.hospSignos.create({
    data: { episodioId: ep.id, ...d, fecha: aFecha(fecha) ?? new Date(), registradoPorUserId: usuario.id, registradoPor: usuario.nombre },
  });
  return NextResponse.json(signos, { status: 201 });
});
