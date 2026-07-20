import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// GET /api/purificadora/config?companyId=xxx
// Devuelve la configuración de la purificadora (o los defaults si aún no se
// guarda ninguna). Autz: sesión web O bearer de satélite.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const config = await prisma.purifConfig.findUnique({ where: { companyId } });
  return NextResponse.json(
    config ?? {
      companyId,
      nombreComercial: null,
      precioGarrafon: 15,
      ivaTasaDefault: 0,
      claveProdServ: "50202306",
      claveUnidad: "H87",
      descripcionFactura: "Agua purificada en garrafón 20 L",
    }
  );
});

const putSchema = z.object({
  companyId: z.string().min(1),
  nombreComercial: z.string().trim().max(120).nullish(),
  precioGarrafon: z.number().positive().optional(),
  ivaTasaDefault: z.number().min(0).max(0.16).optional(),
  claveProdServ: z.string().trim().min(1).max(20).optional(),
  claveUnidad: z.string().trim().min(1).max(10).optional(),
  descripcionFactura: z.string().trim().min(1).max(200).optional(),
});

// PUT /api/purificadora/config — upsert de la configuración.
export const PUT = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const config = await prisma.purifConfig.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
  return NextResponse.json(config);
});
