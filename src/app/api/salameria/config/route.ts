/**
 * GET   /api/salameria/config?companyId=...
 * PATCH /api/salameria/config
 *
 * Configuración de la empresa: series de folio, IVA default, regla de envío de
 * la tienda y días de alerta de caducidad. Se crea sola en el primer GET para
 * que el satélite no tenga que sembrar nada antes de abrir.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireOwner, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const config =
    (await prisma.salConfig.findUnique({ where: { companyId } })) ??
    (await prisma.salConfig.create({ data: { companyId } }));

  return NextResponse.json(config);
});

const patchSchema = z.object({
  companyId: z.string().min(1),
  seriePedido: z.string().min(1).max(10).optional(),
  serieCompra: z.string().min(1).max(10).optional(),
  serieImportacion: z.string().min(1).max(10).optional(),
  ivaTasaDefault: z.number().min(0).max(1).optional(),
  diasAlertaCaducidad: z.number().int().min(0).max(730).optional(),
  tiendaNombre: z.string().min(1).max(80).optional(),
  tiendaDominio: z.string().max(120).nullable().optional(),
  tiendaActiva: z.boolean().optional(),
  envioUmbral: z.number().min(0).optional(),
  envioTarifa: z.number().min(0).optional(),
  envioTarifaBase: z.number().min(0).optional(),
  anticipoPreventa: z.number().min(0).max(1).optional(),
  avisoPrivacidadUrl: z.string().max(300).nullable().optional(),
});

export const PATCH = withAuthz(async (req: Request) => {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  // Prender la tienda pública o mover la regla de envío mueve dinero: es del
  // dueño, no de cualquiera que pueda escribir.
  await requireOwner(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  const config = await prisma.salConfig.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });

  return NextResponse.json(config);
});
