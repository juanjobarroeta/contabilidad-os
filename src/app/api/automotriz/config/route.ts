import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET/PUT /api/automotriz/config?companyId=…
//
// Configuración del vertical por empresa: tasa anual default de plan piso
// (el cron interes-piso acumula el costo financiero por unidad en piso) y la
// regla de comisión del vendedor (% de utilidad y/o monto fijo) que `vender`
// aplica cuando la venta no trae monto explícito.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const config = await prisma.automotrizConfig.findUnique({ where: { companyId } });
  return NextResponse.json(
    config ?? { companyId, planPisoTasaAnual: null, comisionPorcentajeUtilidad: null, comisionFija: null }
  );
});

const putSchema = z.object({
  companyId: z.string().min(1),
  planPisoTasaAnual: z.number().min(0).max(1).nullable().optional(),
  comisionPorcentajeUtilidad: z.number().min(0).max(1).nullable().optional(),
  comisionFija: z.number().min(0).nullable().optional(),
});

export const PUT = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { companyId, ...datos } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const config = await prisma.automotrizConfig.upsert({
    where: { companyId },
    create: { companyId, ...datos },
    update: datos,
  });
  return NextResponse.json(config);
});
