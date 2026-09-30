// Padrón de proveedores del hospital: el Supplier del hub (uno por RFC y
// empresa), con sus datos de pago y sus condiciones de crédito
// (SupplierTerms: de ahí salen los días de crédito de cada orden de compra).

import { z } from "zod";
import type { Prisma } from "@prisma/client";

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
