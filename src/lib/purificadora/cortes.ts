/**
 * Corte del día — helpers compartidos entre las rutas /api/purificadora/cortes*.
 *
 * El corte es el espejo digital del talón del chofer: ventas de ruta (casas),
 * garrafones por empresa/sucursal (crédito), cortesías y gastos. BORRADOR es
 * editable y sin efecto contable; CONFIRMAR genera PurifVenta/PurifGasto y
 * sus asientos en una sola transacción.
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { categoriaGastoSchema, descripcionGasto } from "@/lib/purificadora/categorias";

export const corteInclude = {
  rutas: { include: { ruta: { select: { id: true, nombre: true } } } },
  empresas: {
    include: {
      customer: { select: { id: true, razonSocial: true } },
      sucursal: { select: { id: true, nombre: true } },
    },
  },
  gastos: true,
  ventas: { select: { id: true, folio: true, total: true, estado: true, formaPago: true } },
} as const;

/** Normaliza "YYYY-MM-DD" a medianoche UTC — un corte por día por empresa. */
export function parseFechaCorte(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

const lineasSchema = {
  rutas: z
    .array(
      z.object({
        rutaId: z.string().min(1),
        efectivo: z.number().min(0).default(0),
        transferencia: z.number().min(0).default(0),
        garrafones: z.number().int().min(0).default(0),
      })
    )
    .default([]),
  empresas: z
    .array(
      z.object({
        customerId: z.string().min(1),
        sucursalId: z.string().min(1).nullish(),
        garrafones: z.number().int().positive(),
      })
    )
    .default([]),
  gastos: z
    .array(
      z.object({
        categoria: categoriaGastoSchema,
        // Opcional: sin texto, el gasto se nombra por su categoría (el chofer
        // suele anotar sólo "gasolina $200"). Antes exigir descripción hacía
        // que el renglón se perdiera en silencio.
        descripcion: z.string().trim().max(200).default(""),
        monto: z.number().positive(),
        formaPago: z
          .enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CREDITO"])
          .default("EFECTIVO"),
      })
    )
    .default([])
    .transform((gastos) =>
      gastos.map((g) => ({ ...g, descripcion: descripcionGasto(g.descripcion, g.categoria) }))
    ),
  cortesiasGarrafones: z.number().int().min(0).default(0),
  cortesiasImporte: z.number().min(0).default(0),
  notas: z.string().trim().max(500).nullish(),
};

export const corteCreateSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ...lineasSchema,
});

export const corteUpdateSchema = z.object(lineasSchema);

export type CorteLineas = z.infer<typeof corteUpdateSchema>;

/**
 * Valida que las líneas del corte pertenezcan a la empresa. Devuelve mensaje
 * de error o null.
 */
export async function validarLineas(
  companyId: string,
  data: {
    rutas: { rutaId: string }[];
    empresas: { customerId: string; sucursalId?: string | null }[];
  }
): Promise<string | null> {
  const rutaIds = [...new Set(data.rutas.map((r) => r.rutaId))];
  const customerIds = [...new Set(data.empresas.map((e) => e.customerId))];
  const sucursalIds = [
    ...new Set(data.empresas.map((e) => e.sucursalId).filter(Boolean)),
  ] as string[];

  const [rutas, customers, sucursales] = await Promise.all([
    prisma.purifRuta.findMany({ where: { id: { in: rutaIds }, companyId }, select: { id: true } }),
    prisma.customer.findMany({ where: { id: { in: customerIds }, companyId }, select: { id: true } }),
    prisma.purifSucursal.findMany({
      where: { id: { in: sucursalIds }, companyId },
      select: { id: true, customerId: true },
    }),
  ]);
  if (rutas.length !== rutaIds.length) return "Ruta inválida";
  if (customers.length !== customerIds.length) return "Cliente inválido";
  if (sucursales.length !== sucursalIds.length) return "Sucursal inválida";
  const sucursalById = new Map(sucursales.map((s) => [s.id, s]));
  for (const e of data.empresas) {
    if (e.sucursalId && sucursalById.get(e.sucursalId)?.customerId !== e.customerId) {
      return "La sucursal no pertenece a ese cliente";
    }
  }
  return null;
}
