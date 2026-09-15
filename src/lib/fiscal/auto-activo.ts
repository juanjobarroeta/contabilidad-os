// ─────────────────────────────────────────────────────────────────────────────
// Auto-registro de activo fijo desde un CFDI con naturaleza INVERSION.
//
// El edge del producto es que "solo corre": un CFDI de inversión se capitaliza
// solo al sincronizar, sin que nadie capture nada. El contador sólo revisa/
// corrige (tipo, tasa, tope auto-vs-carga) en /activos — no entra el dato.
//
// Idempotente por invoiceId: nunca crea dos activos para el mismo CFDI.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { clasificarCfdi, type ClasificarInput } from "./clasificar-cfdi";
import { tipoActivoDesdeSubtipo, TASA_DEPRECIACION } from "./depreciacion";

type Db = PrismaClient | Prisma.TransactionClient;

export interface CrearActivoDesdeCfdiArgs {
  companyId: string;
  invoiceId: string;
  /** Subtotal del CFDI = MOI (sin IVA). */
  subtotal: number;
  fecha: Date;
  /** Descripción del primer concepto, si se conoce. */
  descripcion?: string | null;
  /** Insumos del clasificador: usoCfdi + claves de producto. */
  clasifInput: ClasificarInput;
}

/**
 * Crea el ActivoFijo si el CFDI es INVERSION y aún no tiene activo. Devuelve el
 * id creado, o null si no aplica / ya existía. Seguro de llamar siempre.
 */
export async function crearActivoDesdeCfdiSiAplica(
  db: Db,
  args: CrearActivoDesdeCfdiArgs
): Promise<string | null> {
  const clasif = clasificarCfdi(args.clasifInput);
  if (clasif.naturaleza !== "INVERSION") return null;
  if (!args.subtotal || args.subtotal <= 0) return null;

  // Idempotencia: ¿ya hay un activo para este CFDI?
  const existente = await db.activoFijo.findFirst({
    where: { invoiceId: args.invoiceId },
    select: { id: true },
  });
  if (existente) return null;

  const tipo = tipoActivoDesdeSubtipo(clasif.subtipoInversion);
  const creado = await db.activoFijo.create({
    data: {
      companyId: args.companyId,
      invoiceId: args.invoiceId,
      descripcion: (args.descripcion ?? "").trim() || "Inversión (CFDI)",
      tipo,
      moi: args.subtotal,
      fechaAdquisicion: args.fecha,
      tasaAnual: TASA_DEPRECIACION[tipo].tasa,
      // Tope Art. 36-II sólo si el clasificador detectó auto de pasajeros; en
      // I03 ambiguo queda false (sin tope) y autoCreado marca que hay que revisar.
      esAutomovil: clasif.posibleTopeAutomovil === true,
      autoCreado: true,
    },
  });
  return creado.id;
}

/**
 * Retira el activo que el sistema creó solo cuando el CFDI deja de ser
 * INVERSIÓN. Devuelve cuántos retiró.
 *
 * Reclasificar a GASTO deduce el CFDI completo; si el activo se queda, sigue
 * depreciándose mes con mes y LA MISMA COMPRA SE DEDUCE DOS VECES. No se veía
 * porque el activo vive en otra pantalla que la factura.
 *
 * Sólo se va el `autoCreado`: uno capturado a mano, o ya revisado por el
 * contador (editarlo limpia la bandera), es suyo — borrárselo por editar la
 * factura sería peor que el problema. Y no hay camino de vuelta automático: de
 * GASTO a INVERSIÓN el activo se registra desde la factura, con su botón, para
 * que el importe y la fecha los ponga quien sabe.
 */
export async function retirarActivosPorReclasificacion(
  db: Db,
  args: { companyId: string; invoiceId: string; naturaleza: string },
): Promise<number> {
  if (args.naturaleza === "INVERSION") return 0;
  const { count } = await db.activoFijo.deleteMany({
    where: { companyId: args.companyId, invoiceId: args.invoiceId, autoCreado: true },
  });
  return count;
}
