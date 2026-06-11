/**
 * PUT /api/construccion/suppliers/[id]/terms
 *
 * Upsert de los términos de crédito de un proveedor (SupplierTerms,
 * tabla operativa del módulo construcción — ver BACKEND-SUPPLIER-TERMS.md
 * en bartiz). La UI de bartiz escribe aquí y lee `supplier.terms` en el
 * list/detail de proveedores.
 *
 * Body: { tieneCredito, diasCredito, limiteCredito }
 * Si tieneCredito es false se normaliza a diasCredito: 0 y
 * limiteCredito: null. Responde con el objeto terms guardado.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const termsSchema = z.object({
  tieneCredito: z.coerce.boolean().optional().default(false),
  diasCredito: z.coerce.number().int().min(0).max(365).optional().default(0),
  limiteCredito: z.coerce.number().nonnegative().nullable().optional(),
});

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const supplier = await prisma.supplier.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!supplier) throw new AuthzError(404, "Proveedor no encontrado");
    await requireWriter(supplier.companyId, req);
    await requireModule(supplier.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = termsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { tieneCredito, diasCredito, limiteCredito } = parsed.data;
    const data = {
      tieneCredito,
      diasCredito: tieneCredito ? diasCredito : 0,
      limiteCredito: tieneCredito && limiteCredito != null ? limiteCredito : null,
    };

    const terms = await prisma.supplierTerms.upsert({
      where: { supplierId: id },
      create: { supplierId: id, ...data },
      update: data,
    });

    return NextResponse.json(terms);
  }
);
