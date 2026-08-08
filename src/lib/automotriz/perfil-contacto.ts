// ─────────────────────────────────────────────────────────────────────────────
// Perfil 360° de un contacto (cliente o proveedor) para el vertical automotriz.
//
// El hub guarda la contraparte de TODO CFDI (emitido o recibido) como Customer
// por RFC, así que ambos perfiles pivotean sobre el mismo customerId:
//   • CLIENTE   → facturas INGRESO: qué le facturamos, qué nos ha pagado
//     (conciliación bancaria), qué cobros aún no tienen su REP emitido
//     (obligación nuestra, RMF 2.7.1.32) y qué unidades ha comprado.
//   • PROVEEDOR → facturas EGRESO: qué nos facturó, qué le hemos pagado, qué
//     pagos aún no tienen el REP recibido (riesgo para NUESTRA deducción,
//     Art. 5-I LIVA) y qué unidades nos suministró.
//
// Reusa las mismas fuentes que el motor fiscal: ConciliacionDetalle para lo
// cobrado/pagado en banco y PagoDoctoRelacionado (por UUID normalizado) para
// lo amparado por complementos — el mismo empate de fiscal/audit/rep-faltante.
// Solo lectura: no muta nada.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

type Db = PrismaClient | Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface FacturaPerfil {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  fecha: Date;
  total: number;
  metodoPago: string;
  /** Cobrado (cliente) o pagado (proveedor): PUE = total por definición; PPD =
   *  mejor evidencia entre REPs que la amparan y conciliación bancaria. */
  pagado: number;
  /** Amparado por complementos de pago (REPs) hacia esta factura. */
  amparadoRep: number;
  /** PPD: pagado − amparado (>0 = falta complemento). PUE no aplica (0). */
  repPendiente: number;
  saldo: number;
}

export interface PerfilContacto {
  contacto: {
    id: string;
    rfc: string;
    razonSocial: string;
    email: string | null;
    phone: string | null;
  };
  direccion: "CLIENTE" | "PROVEEDOR";
  resumen: {
    numFacturas: number;
    totalFacturado: number;
    totalPagado: number;
    saldo: number;
    /** Monto PPD pagado que aún no ampara un complemento. */
    repPendienteMonto: number;
    repPendienteFacturas: number;
  };
  facturas: FacturaPerfil[];
  unidades: Array<{
    id: string;
    vin: string;
    marca: string;
    modelo: string;
    anio: number;
    estado: string;
    fechaCompra: Date | null;
    fechaVenta: Date | null;
    costoCompra: number;
    precioVenta: number | null;
  }>;
}

/**
 * Arma el perfil. `direccion` decide el lado: CLIENTE mira facturas INGRESO y
 * unidades vendidas a él; PROVEEDOR mira EGRESO y unidades que nos suministró.
 * Devuelve null si el contacto no existe o es de otra empresa (fail-closed).
 */
export async function perfilContacto(
  db: Db,
  companyId: string,
  customerId: string,
  direccion: "CLIENTE" | "PROVEEDOR"
): Promise<PerfilContacto | null> {
  const contacto = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true, companyId: true, rfc: true, razonSocial: true, email: true, phone: true },
  });
  if (!contacto || contacto.companyId !== companyId) return null;

  const tipo = direccion === "CLIENTE" ? "INGRESO" : "EGRESO";
  const facturasDb = await db.invoice.findMany({
    where: { companyId, customerId, tipo, status: { not: "CANCELLED" } },
    select: {
      id: true,
      uuid: true,
      serie: true,
      folio: true,
      fecha: true,
      total: true,
      metodoPago: true,
      conciliacionDetalles: { select: { montoAsignado: true } },
    },
    orderBy: { fecha: "desc" },
  });

  // REPs que amparan estas facturas, empatadas por UUID normalizado — cubre
  // REP en mayúsculas vs PAC en minúsculas, igual que rep-faltante.ts.
  const uuids = facturasDb.map((f) => f.uuid).filter(Boolean) as string[];
  const links = uuids.length
    ? await db.pagoDoctoRelacionado.findMany({
        where: { parentUuid: { in: variantesUuid(uuids) } },
        select: { parentUuid: true, impPagado: true },
      })
    : [];
  const amparadoPorUuid = new Map<string, number>();
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    amparadoPorUuid.set(k, (amparadoPorUuid.get(k) ?? 0) + (l.impPagado ?? 0));
  }

  const facturas: FacturaPerfil[] = facturasDb.map((f) => {
    const conciliado = r2(f.conciliacionDetalles.reduce((s, d) => s + Math.abs(d.montoAsignado), 0));
    const amparadoRep = f.uuid ? r2(amparadoPorUuid.get(normalizarUuid(f.uuid)) ?? 0) : 0;
    // Evidencia de cobro/pago — misma semántica que el motor de IVA en flujo:
    // PUE queda pagada en su emisión (pago en una sola exhibición); PPD por la
    // mejor evidencia disponible (REPs que la amparan o conciliación bancaria),
    // para que la cartera sea real aunque la empresa no haya cargado bancos.
    const pagado = f.metodoPago === "PPD" ? r2(Math.max(conciliado, amparadoRep)) : f.total;
    const repPendiente = f.metodoPago === "PPD" ? r2(Math.max(0, conciliado - amparadoRep)) : 0;
    return {
      id: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      fecha: f.fecha,
      total: f.total,
      metodoPago: f.metodoPago,
      pagado,
      amparadoRep,
      repPendiente,
      saldo: r2(Math.max(0, f.total - pagado)),
    };
  });

  const unidadesDb = await db.vehiculo.findMany({
    where:
      direccion === "CLIENTE"
        ? { companyId, clienteId: customerId }
        // Proveedor: por FK canónico o por el RFC del contacto (el deriver aún
        // puede no haber resuelto supplierId en compras).
        : { companyId, OR: [{ supplier: { rfc: contacto.rfc } }, { compraInvoice: { customerId } }] },
    select: {
      id: true, vin: true, marca: true, modelo: true, anio: true, estado: true,
      fechaCompra: true, fechaVenta: true, costoCompra: true, precioVenta: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const conRepPendiente = facturas.filter((f) => f.repPendiente > 1); // tolerancia de centavos
  return {
    contacto: {
      id: contacto.id,
      rfc: contacto.rfc,
      razonSocial: contacto.razonSocial,
      email: contacto.email,
      phone: contacto.phone,
    },
    direccion,
    resumen: {
      numFacturas: facturas.length,
      totalFacturado: r2(facturas.reduce((s, f) => s + f.total, 0)),
      totalPagado: r2(facturas.reduce((s, f) => s + f.pagado, 0)),
      saldo: r2(facturas.reduce((s, f) => s + f.saldo, 0)),
      repPendienteMonto: r2(conRepPendiente.reduce((s, f) => s + f.repPendiente, 0)),
      repPendienteFacturas: conRepPendiente.length,
    },
    facturas,
    unidades: unidadesDb,
  };
}
