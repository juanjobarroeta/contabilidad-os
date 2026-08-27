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
  /** Presente sólo si el CFDI lo timbró el PAC desde aquí: habilita el PDF. */
  facturapiId: string | null;
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
    /** Notas de crédito de este lado (restan a lo facturado). */
    totalNotasCredito: number;
    /** Suma de anticipos: incluida en totalFacturado, pero también dentro de
     *  la factura final — lo que el contador debe conciliar. */
    totalAnticipos: number;
  };
  facturas: FacturaPerfil[];
  /**
   * Anticipos (clave 84111506): cobros a cuenta que la factura final vuelve a
   * incluir. Contarlos como facturación aparte duplica el ingreso y deja un
   * saldo fantasma por el mismo monto — se reportan por separado.
   */
  anticipos: Array<{
    id: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    facturapiId: string | null;
    fecha: Date;
    total: number;
  }>;
  /** Notas de crédito (tipoSat "E") de este lado: restan a lo facturado. */
  notasCredito: Array<{
    id: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    facturapiId: string | null;
    fecha: Date;
    total: number;
  }>;
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
    /** Utilidad de ESA unidad (venta − costo − costos − comisión). Null si el
     *  costo de compra no se conoce (compra fuera del archivo del SAT). */
    utilidad: number | null;
  }>;
  /** Cuánto dejó este cliente en unidades (sólo las de costo conocido). */
  rentabilidad: {
    unidades: number;
    venta: number;
    utilidad: number;
    margen: number | null;
    /** Unidades sin costo conocido: excluidas del cálculo, reportadas aparte. */
    sinCosto: number;
  };
  /** Historial de taller (ServicioVenta derivadas de sus CFDIs). */
  servicio: {
    ordenes: number;
    total: number;
    manoObra: number;
    refacciones: number;
    ultimaVisita: Date | null;
    ultimas: Array<{
      id: string;
      fecha: Date;
      concepto: string | null;
      total: number;
      manoObra: number;
      refacciones: number;
      /** Unidad atendida cuando el CFDI trae el VIN (liga al expediente). */
      vehiculo: { id: string; vin: string; marca: string; modelo: string; anio: number } | null;
      /** El CFDI que amparó la orden — para ver/descargar XML y PDF. */
      invoice: { id: string; uuid: string | null; serie: string | null; folio: string | null; facturapiId: string | null };
      /** Orden de taller que amparó la venta; null si el CFDI no derivó una. */
      orden: { id: string; folio: number } | null;
    }>;
  };
  /**
   * Refacciones que le hemos vendido (kardex ligado a sus CFDIs). OJO: NO es
   * ingreso adicional — estas piezas ya están dentro de las facturas, sea
   * como parte de una orden de taller o como venta de mostrador. El desglose
   * `enOrdenes`/`mostrador` dice de dónde viene cada peso para que nadie sume
   * taller + refacciones y se invente ventas.
   */
  refacciones: {
    partes: number;
    piezas: number;
    importe: number;
    /** Importe que va dentro de una orden de taller (ya contado en servicio). */
    enOrdenes: number;
    /** Importe de ventas de mostrador (facturas sin línea de servicio). */
    mostrador: number;
    top: Array<{ numeroParte: string; descripcion: string; piezas: number; importe: number }>;
  };
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
  const todasDb = await db.invoice.findMany({
    where: { companyId, customerId, tipo, status: { not: "CANCELLED" } },
    select: {
      id: true,
      uuid: true,
      serie: true,
      folio: true,
      fecha: true,
      total: true,
      metodoPago: true,
      tipoSat: true,
      facturapiId: true,
      // Prefiltro barato para detectar anticipos (clave 84111506); el rawXml
      // no se trae completo — sólo se pregunta si contiene la clave.
      rawXml: true,
      conciliacionDetalles: { select: { montoAsignado: true } },
    },
    orderBy: { fecha: "desc" },
  });
  // Las notas de crédito viajan como INGRESO/EGRESO con tipoSat "E": contarlas
  // junto a las facturas inflaba «facturado» y su saldo. Van aparte y restan.
  // Anticipo: CFDI cuyo ÚNICO concepto es la clave 84111506 del SAT. Se marca
  // sin sacarlo de `facturas` (fiscalmente es un ingreso timbrado y así lo ve
  // el motor de IVA); lo que cambia es que la pantalla lo señala y el contador
  // ve el monto que está contado dos veces: aquí y dentro de la factura final.
  const esAnticipo = (raw: string | null) =>
    raw != null &&
    raw.includes('ClaveProdServ="84111506"') &&
    (raw.match(/<(?:[\w-]+:)?Concepto\b/gi) ?? []).length === 1;

  const facturasDb = todasDb.filter((f) => (f.tipoSat ?? "I") !== "E");
  const anticipos = facturasDb
    .filter((f) => esAnticipo(f.rawXml))
    .map((f) => ({
      id: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      facturapiId: f.facturapiId,
      fecha: f.fecha,
      total: f.total,
    }));
  const notasCredito = todasDb
    .filter((f) => (f.tipoSat ?? "I") === "E")
    .map((f) => ({
      id: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      facturapiId: f.facturapiId,
      fecha: f.fecha,
      total: f.total,
    }));

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
    const conciliado = r2(f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0));
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
      facturapiId: f.facturapiId,
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
      comisionMonto: true,
      costos: { select: { monto: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Utilidad por unidad: misma fórmula que el reporte de rentabilidad —
  // venta − costo de compra − costos capitalizados/financieros − comisión. Las
  // unidades sin costo conocido (compra anterior al archivo de 5 años del SAT)
  // NO entran al agregado: inventarían una utilidad igual a la venta entera.
  const unidades = unidadesDb.map((v) => {
    const costos = v.costos.reduce((s, c) => s + c.monto, 0);
    const sinCosto = v.costoCompra <= 0;
    const utilidad =
      v.precioVenta == null || sinCosto
        ? null
        : r2(v.precioVenta - v.costoCompra - costos - v.comisionMonto);
    const { costos: _costos, comisionMonto: _com, ...resto } = v;
    return { ...resto, utilidad };
  });
  const conUtilidad = unidades.filter((u) => u.utilidad != null);
  const ventaConUtilidad = r2(conUtilidad.reduce((s, u) => s + (u.precioVenta ?? 0), 0));
  const utilidadTotal = r2(conUtilidad.reduce((s, u) => s + (u.utilidad ?? 0), 0));

  // Taller: las ventas de servicio derivadas de SUS CFDIs (fase 5).
  const serviciosDb = await db.servicioVenta.findMany({
    where: { companyId, clienteId: customerId },
    select: {
      id: true, fecha: true, concepto: true, total: true, manoObra: true, refacciones: true,
      vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true } },
      invoice: { select: { id: true, uuid: true, serie: true, folio: true, facturapiId: true } },
      // La orden de taller que ampara esta venta. Es la MISMA operación vista
      // desde el otro lado, así que desde el expediente del cliente se puede
      // abrir la orden completa en vez de volver a buscarla por folio.
      orden: { select: { id: true, folio: true } },
    },
    orderBy: { fecha: "desc" },
  });

  // Refacciones vendidas (o compradas, del lado proveedor): kardex ligado a
  // los CFDIs de este contacto. Se agrega por número de parte.
  const movs = await db.refaccionMovimiento.findMany({
    where: {
      tipo: direccion === "CLIENTE" ? "SALIDA_VENTA" : "ENTRADA_COMPRA",
      refaccion: { companyId },
      invoice: { customerId },
    },
    select: {
      cantidad: true,
      montoUnitario: true,
      refaccion: { select: { numeroParte: true, descripcion: true } },
      // ¿La factura que ampara la pieza es una orden de taller? Eso decide si
      // el importe ya está contado dentro de `servicio` o es mostrador puro.
      invoice: { select: { servicioVenta: { select: { id: true } } } },
    },
    take: 5000,
  });
  let importeEnOrdenes = 0;
  let importeMostrador = 0;
  const porParte = new Map<string, { numeroParte: string; descripcion: string; piezas: number; importe: number }>();
  for (const m of movs) {
    const clave = m.refaccion.numeroParte;
    const acc = porParte.get(clave) ?? {
      numeroParte: clave,
      descripcion: m.refaccion.descripcion,
      piezas: 0,
      importe: 0,
    };
    const piezas = Math.abs(m.cantidad);
    const importe = piezas * (m.montoUnitario ?? 0);
    acc.piezas += piezas;
    acc.importe = r2(acc.importe + importe);
    porParte.set(clave, acc);
    if (m.invoice?.servicioVenta) importeEnOrdenes += importe;
    else importeMostrador += importe;
  }
  const partes = [...porParte.values()].sort((a, b) => b.importe - a.importe);

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
      totalNotasCredito: r2(notasCredito.reduce((s, n) => s + n.total, 0)),
      totalAnticipos: r2(anticipos.reduce((s, a) => s + a.total, 0)),
    },
    facturas,
    anticipos,
    notasCredito,
    unidades,
    rentabilidad: {
      unidades: conUtilidad.length,
      venta: ventaConUtilidad,
      utilidad: utilidadTotal,
      margen: ventaConUtilidad > 0 ? r2((utilidadTotal / ventaConUtilidad) * 100) : null,
      sinCosto: unidades.filter((u) => u.precioVenta != null && u.utilidad == null).length,
    },
    servicio: {
      ordenes: serviciosDb.length,
      total: r2(serviciosDb.reduce((s, x) => s + x.total, 0)),
      manoObra: r2(serviciosDb.reduce((s, x) => s + x.manoObra, 0)),
      refacciones: r2(serviciosDb.reduce((s, x) => s + x.refacciones, 0)),
      ultimaVisita: serviciosDb[0]?.fecha ?? null,
      ultimas: serviciosDb.slice(0, 25).map((s) => ({
        id: s.id,
        fecha: s.fecha,
        concepto: s.concepto,
        total: s.total,
        manoObra: s.manoObra,
        refacciones: s.refacciones,
        vehiculo: s.vehiculo ?? null,
        invoice: s.invoice,
        orden: s.orden ?? null,
      })),
    },
    refacciones: {
      partes: partes.length,
      piezas: r2(partes.reduce((s, p) => s + p.piezas, 0)),
      importe: r2(partes.reduce((s, p) => s + p.importe, 0)),
      enOrdenes: r2(importeEnOrdenes),
      mostrador: r2(importeMostrador),
      top: partes.slice(0, 15),
    },
  };
}
