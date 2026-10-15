// Padrón de proveedores del hospital: el Supplier del hub (uno por RFC y
// empresa), con sus datos de pago y sus condiciones de crédito
// (SupplierTerms: de ahí salen los días de crédito de cada orden de compra).

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";

export const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

const opcional = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));

export const proveedorSchema = z.object({
  companyId: z.string().min(1).optional(),
  rfc: z.string().trim().toUpperCase().regex(RFC_RE, "RFC inválido (12 o 13 caracteres, como en la constancia)").optional(),
  razonSocial: z.string().trim().min(2).max(200).optional(),
  regimenFiscal: z.string().trim().regex(/^\d{3}$/, "Régimen de 3 dígitos").nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  clabe: z.string().trim().regex(/^\d{18}$/, "La CLABE debe tener 18 dígitos").nullable().optional().or(z.literal("").transform(() => null)),
  banco: opcional(60),
  titularCuenta: opcional(200),
  tieneCredito: z.boolean().optional(),
  diasCredito: z.number().int().min(0).max(365).optional(),
});
export type ProveedorInput = z.infer<typeof proveedorSchema>;

/** Datos de pago o crédito: los que exigen FINANZAS_ESCRIBIR. */
export function tocaDatosDePago(d: ProveedorInput): boolean {
  return d.clabe !== undefined || d.banco !== undefined || d.titularCuenta !== undefined || d.tieneCredito !== undefined || d.diasCredito !== undefined;
}

export function enmascararClabe(clabe: string | null): string | null {
  return clabe ? `••••${clabe.slice(-4)}` : null;
}

export async function guardarTerminos(tx: Prisma.TransactionClient, supplierId: string, tieneCredito: boolean, diasCredito?: number) {
  const data = { tieneCredito, diasCredito: tieneCredito ? diasCredito ?? 30 : 0 };
  await tx.supplierTerms.upsert({ where: { supplierId }, create: { supplierId, ...data }, update: data });
}

export const SELECT_PROVEEDOR = {
  id: true, rfc: true, razonSocial: true, regimenFiscal: true, email: true, clabe: true, banco: true, titularCuenta: true,
  terms: { select: { tieneCredito: true, diasCredito: true } },
} as const;

export const completarSchema = z.object({
  clabe: z.string().trim().regex(/^\d{18}$/, "La CLABE debe tener 18 dígitos").optional(),
  banco: z.string().trim().min(1).max(60).optional(),
  titularCuenta: z.string().trim().min(1).max(200).optional(),
  tieneCredito: z.boolean().optional(),
  diasCredito: z.number().int().min(0).max(365).optional(),
});
export type CompletarInput = z.infer<typeof completarSchema>;

/**
 * Completa lo que le FALTA al proveedor con lo que compras capturó al cotizar:
 * la cuenta (CLABE, banco, titular) sólo si no tiene CLABE, y el crédito sólo
 * si nunca se registraron sus condiciones. Nunca sobrescribe: cambiar una
 * CLABE o un crédito ya registrado sigue siendo de Proveedores con
 * FINANZAS_ESCRIBIR (es la vía para desviar pagos). Devuelve qué se guardó y
 * qué se dejó como estaba.
 */
export async function completarProveedor(db: PrismaClient, companyId: string, id: string, d: CompletarInput) {
  const existe = await db.supplier.count({ where: { id, companyId } });
  if (!existe) return null;
  const guardados: string[] = [];
  const omitidos: string[] = [];
  const cuenta = d.clabe !== undefined || d.banco !== undefined || d.titularCuenta !== undefined;
  await db.$transaction(async (tx) => {
    if (cuenta) {
      // Condicional en la misma sentencia: si otro ya la llenó, no se toca.
      const n = d.clabe
        ? (await tx.supplier.updateMany({
            where: { id, clabe: null },
            data: { clabe: d.clabe, ...(d.banco ? { banco: d.banco } : {}), ...(d.titularCuenta ? { titularCuenta: d.titularCuenta } : {}) },
          })).count
        : 0;
      (n ? guardados : omitidos).push("cuenta");
    }
    if (d.tieneCredito !== undefined) {
      const data = { tieneCredito: d.tieneCredito, diasCredito: d.tieneCredito ? d.diasCredito ?? 30 : 0 };
      const r = await tx.supplierTerms.createMany({ data: [{ supplierId: id, ...data }], skipDuplicates: true });
      (r.count ? guardados : omitidos).push("credito");
    }
  });
  return { guardados, omitidos };
}
