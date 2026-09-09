// ─────────────────────────────────────────────────────────────────────────────
// ANTICIPOS COBRADOS SIN CFDI — una obligación que envejece, no un aviso.
//
// Un depósito de cliente sin factura no es ingreso: es un pasivo (206.01), y
// por ley obliga a emitir un CFDI de anticipo. El riesgo de tratarlo como un
// simple «pendiente» es que se archive y nadie lo mire: el IVA de ese cobro se
// causó (Art. 1-B) y no se declaró.
//
// Por eso el modelo NO es «hay o no hay avisos», es ANTIGÜEDAD. Un anticipo de
// ayer es alguien que no ha llegado a facturar; uno de hace tres meses es
// exposición fiscal acumulada. La lista se ordena por el más viejo primero,
// porque ése es el que hay que resolver hoy.
//
// Etiquetar NO lo saca de la lista. Sólo lo saca el CFDI: cuando el comprobante
// se concilia con el movimiento, el pasivo se convierte en la venta que era.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";

/** Días a partir de los cuales el anticipo pide atención, y a partir de los
 *  cuales ya es exposición: el CFDI de anticipo se emite al recibir el pago,
 *  así que un mes sin emitirlo no es un descuido de calendario. */
export const DIAS_ATENCION = 8;
export const DIAS_VENCIDO = 30;

export type SeveridadAnticipo = "reciente" | "atencion" | "vencido";

/** Severidad por antigüedad. PURA. */
export function severidadAnticipo(dias: number): SeveridadAnticipo {
  if (dias >= DIAS_VENCIDO) return "vencido";
  if (dias >= DIAS_ATENCION) return "atencion";
  return "reciente";
}

/** Días transcurridos entre el cobro y hoy (o la fecha de corte dada). PURA. */
export function diasDesde(fecha: Date, hoy: Date): number {
  return Math.max(0, Math.floor((hoy.getTime() - fecha.getTime()) / 86_400_000));
}

/**
 * Quién debe el comprobante — cambia la acción, no la contabilidad.
 *   CLIENTE: lo debemos NOSOTROS. Obligación legal propia, e IVA causado al
 *            cobro que no se ha declarado. Se resuelve emitiendo el CFDI.
 *   PROVEEDOR: nos lo debe EL PROVEEDOR. Sin él no hay deducción ni IVA
 *            acreditable. Se resuelve reclamándoselo.
 */
export type DireccionAnticipo = "CLIENTE" | "PROVEEDOR";

export interface AnticipoPendiente {
  id: string;
  direccion: DireccionAnticipo;
  fecha: string;
  monto: number;
  /** A quién se le debe la factura, si el movimiento lo identificó. */
  cliente: string | null;
  rfc: string | null;
  descripcion: string;
  banco: string | null;
  dias: number;
  severidad: SeveridadAnticipo;
}

export interface ResumenAnticipos {
  total: number;
  /** Los que NOSOTROS debemos facturar (obligación legal propia). */
  porFacturar: number;
  /** Los que el proveedor nos debe comprobar (sin deducción hasta entonces). */
  porRecibir: number;
  monto: number;
  /** El más viejo manda: es el que define la urgencia del conjunto. */
  diasMaximo: number;
  vencidos: number;
  montoVencido: number;
  anticipos: AnticipoPendiente[];
}

/**
 * Anticipos cobrados que siguen sin CFDI, del más viejo al más nuevo.
 *
 * `hoy` se recibe para poder fijar la fecha en pruebas y para calcular la
 * antigüedad contra la fecha de corte de un cierre, no siempre contra el reloj.
 */
export async function anticiposPendientes(
  companyId: string,
  hoy: Date = new Date(),
): Promise<ResumenAnticipos> {
  const movs = await prisma.bankTransaction.findMany({
    where: { companyId, status: "IGNORED", notes: { in: ["ANTICIPO_CLIENTE", "ANTICIPO_PROVEEDOR"] } },
    select: {
      id: true, fecha: true, monto: true, descripcion: true, notes: true,
      contraparteNombre: true, contraparteRfc: true,
      bankAccount: { select: { banco: true } },
    },
    orderBy: { fecha: "asc" },
  });

  const anticipos: AnticipoPendiente[] = movs.map((m) => {
    const dias = diasDesde(m.fecha, hoy);
    return {
      id: m.id,
      direccion: m.notes === "ANTICIPO_PROVEEDOR" ? "PROVEEDOR" : "CLIENTE",
      fecha: m.fecha.toISOString().slice(0, 10),
      monto: Math.abs(Number(m.monto)),
      cliente: m.contraparteNombre,
      rfc: m.contraparteRfc,
      descripcion: m.descripcion,
      banco: m.bankAccount?.banco ?? null,
      dias,
      severidad: severidadAnticipo(dias),
    };
  });

  const vencidos = anticipos.filter((a) => a.severidad === "vencido");
  return {
    total: anticipos.length,
    porFacturar: anticipos.filter((a) => a.direccion === "CLIENTE").length,
    porRecibir: anticipos.filter((a) => a.direccion === "PROVEEDOR").length,
    monto: anticipos.reduce((s, a) => s + a.monto, 0),
    diasMaximo: anticipos.reduce((m, a) => Math.max(m, a.dias), 0),
    vencidos: vencidos.length,
    montoVencido: vencidos.reduce((s, a) => s + a.monto, 0),
    anticipos,
  };
}
