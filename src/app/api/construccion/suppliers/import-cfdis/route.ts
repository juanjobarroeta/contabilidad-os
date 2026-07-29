import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

/**
 * POST /api/construccion/suppliers/import-cfdis  { companyId }
 *
 * Siembra el catálogo de proveedores desde los CFDIs RECIBIDOS: todo emisor
 * que alguna vez nos facturó (Invoice tipo EGRESO; el emisor vive como fila
 * de Customer, así los importa el sync del SAT) se da de alta como Supplier
 * si su RFC aún no existe. Idempotente — repetirlo sólo agrega los nuevos.
 *
 * Sólo OWNER/ADMIN. Se excluyen el RFC de la propia empresa y el RFC
 * genérico de público en general.
 */

const schema = z.object({ companyId: z.string().min(1) });

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  const { companyId } = parsed.data;

  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "CONSTRUCCION");

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });

  // Emisores de CFDIs recibidos (agrupados vía su fila de Customer).
  const emisores = await prisma.customer.findMany({
    where: {
      companyId,
      invoices: {
        some: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" } },
      },
    },
    select: {
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      email: true,
      _count: {
        select: {
          invoices: { where: { tipo: "EGRESO", status: { not: "CANCELLED" } } },
        },
      },
    },
  });

  const EXCLUIR = new Set(
    [company?.rfc?.toUpperCase(), "XAXX010101000", "XEXX010101000"].filter(Boolean) as string[]
  );

  const existentes = await prisma.supplier.findMany({
    where: { companyId },
    select: { rfc: true },
  });
  const yaExiste = new Set(existentes.map((s) => s.rfc.toUpperCase()));

  const creados: { rfc: string; razonSocial: string; cfdis: number }[] = [];
  let omitidos = 0;
  for (const e of emisores) {
    const rfc = e.rfc.toUpperCase().trim();
    if (!rfc || EXCLUIR.has(rfc)) { omitidos++; continue; }
    if (yaExiste.has(rfc)) { omitidos++; continue; }
    await prisma.supplier.create({
      data: {
        companyId,
        rfc,
        razonSocial: e.razonSocial,
        regimenFiscal: e.regimenFiscal || null,
        email: e.email || null,
      },
    });
    yaExiste.add(rfc);
    creados.push({ rfc, razonSocial: e.razonSocial, cfdis: e._count.invoices });
  }

  creados.sort((a, b) => b.cfdis - a.cfdis);
  return NextResponse.json({
    creados: creados.length,
    omitidos,
    emisoresDetectados: emisores.length,
    proveedores: creados.slice(0, 50),
  });
});
