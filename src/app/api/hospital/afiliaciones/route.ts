/**
 * GET  /api/hospital/afiliaciones?companyId=…[&todas=1]
 * POST /api/hospital/afiliaciones { companyId, numero, descripcion?, adquirente?, tasa? } → 201
 *
 * Las afiliaciones de terminal, una por cada línea que el adquirente liquida
 * por separado (si su estado de cuenta parte crédito de débito, son dos). La
 * `tasa` es de referencia: sirve para levantar la mano cuando la comisión
 * cobrada no se parece a la pactada, nunca para calcular la liquidación.
 * Ver src/lib/hospital/cobros.ts y liquidaciones.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { afiliacionResumen } from "@/lib/hospital/cobros";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const todas = searchParams.get("todas") === "1";
  const afiliaciones = await prisma.hospAfiliacion.findMany({
    where: { companyId, ...(todas ? {} : { activa: true }) },
    include: { _count: { select: { cobros: true } } },
    orderBy: [{ activa: "desc" }, { numero: "asc" }],
  });
  return NextResponse.json({ afiliaciones: afiliaciones.map(afiliacionResumen) });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  numero: z.string().trim().min(1).max(40),
  descripcion: z.string().trim().max(120).nullable().optional(),
  adquirente: z.string().trim().max(60).nullable().optional(),
  /** Tasa como fracción: 1.95 % se captura 0.0195. */
  tasa: z.number().min(0).max(0.2).nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  const yaExiste = await prisma.hospAfiliacion.findFirst({ where: { companyId: d.companyId, numero: d.numero }, select: { id: true } });
  if (yaExiste) return error("Esa afiliación ya está dada de alta", 409);

  const afiliacion = await prisma.hospAfiliacion.create({
    data: {
      companyId: d.companyId,
      numero: d.numero,
      descripcion: d.descripcion ?? null,
      adquirente: d.adquirente ?? null,
      tasa: d.tasa ?? null,
    },
    include: { _count: { select: { cobros: true } } },
  });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.afiliacion.alta",
    entidad: "HospAfiliacion",
    entidadId: afiliacion.id,
    detalle: { numero: afiliacion.numero, adquirente: afiliacion.adquirente },
  });
  return NextResponse.json(afiliacionResumen(afiliacion), { status: 201 });
});
