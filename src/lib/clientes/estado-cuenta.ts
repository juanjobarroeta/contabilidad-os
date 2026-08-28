// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DE CUENTA DEL CLIENTE — el entregable de cobranza.
//
// Distinto del auxiliar de cuentas (Anexo 24): aquél es por CUENTA CONTABLE y
// mezcla a todos los clientes dentro de 105.01; éste es por TERCERO — un RFC,
// sus facturas como cargos, sus cobros CON EVIDENCIA BANCARIA como abonos
// (la disciplina de la casa: el banco es la verdad), saldo corrido y
// antigüedad. Es lo que el despacho manda cada mes a su cliente.
//
// El REP (complemento de pago) aparece como MARCADOR fiscal por factura —
// «¿ya se emitió el complemento?» — nunca como evidencia de cobro: un REP sin
// movimiento bancario conciliado es exactamente la clase de divergencia que
// este documento debe delatar, no ocultar.
//
// Núcleo PURO (armarEstadoDeCuenta) + cargador de BD, mismo patrón que el
// motor de posteo.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { esComprobanteDeEgreso } from "../contabilidad/nota-credito";

export interface FacturaInput {
  id: string;
  uuid: string | null;
  fecha: Date;
  referencia: string; // serie+folio o UUID corto
  total: number;
  esNotaCredito: boolean;
}

export interface CobroInput {
  fecha: Date;
  descripcion: string;
  invoiceId: string;
  monto: number; // aplicado a ESA factura (montoAsignado en 1-a-varios)
}

export interface MovimientoEstado {
  fecha: string; // YYYY-MM-DD
  tipo: "FACTURA" | "NOTA_CREDITO" | "COBRO";
  referencia: string;
  cargo: number;
  abono: number;
  saldo: number; // corrido
}

export interface FacturaAbierta {
  fecha: string;
  referencia: string;
  uuid: string | null;
  total: number;
  cobrado: number;
  saldo: number;
  diasVencida: number;
  repEmitido: boolean;
}

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

export interface EstadoDeCuentaData {
  saldoInicial: number;
  cargos: number;
  abonos: number;
  saldoFinal: number;
  movimientos: MovimientoEstado[];
  abiertas: FacturaAbierta[];
  aging: Record<AgingBucket, number>;
  notasCreditoPeriodo: number;
  avisos: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Núcleo puro. `facturas` y `cobros` traen la historia completa del cliente
 * (el saldo inicial del rango se deriva de lo anterior a `desde`); los REPs
 * llegan como conjunto de UUIDs con complemento emitido.
 */
export function armarEstadoDeCuenta(input: {
  facturas: FacturaInput[];
  cobros: CobroInput[];
  repsPorUuid: Set<string>;
  desde: Date;
  hasta: Date;
  hoy: Date;
}): EstadoDeCuentaData {
  const { facturas, cobros, repsPorUuid, desde, hasta, hoy } = input;
  const avisos: string[] = [];

  // Cronología completa para el saldo corrido.
  type Evento =
    | { fecha: Date; orden: 0; tipo: "FACTURA" | "NOTA_CREDITO"; referencia: string; monto: number }
    | { fecha: Date; orden: 1; tipo: "COBRO"; referencia: string; monto: number };
  const eventos: Evento[] = [
    ...facturas.map((f) => ({
      fecha: f.fecha,
      orden: 0 as const,
      tipo: f.esNotaCredito ? ("NOTA_CREDITO" as const) : ("FACTURA" as const),
      referencia: f.referencia,
      monto: f.total,
    })),
    ...cobros.map((c) => ({
      fecha: c.fecha,
      orden: 1 as const,
      tipo: "COBRO" as const,
      referencia: c.descripcion.slice(0, 60),
      monto: c.monto,
    })),
  ].sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.orden - b.orden);

  let saldo = 0;
  let saldoInicial = 0;
  let cargos = 0;
  let abonos = 0;
  let notasCreditoPeriodo = 0;
  const movimientos: MovimientoEstado[] = [];
  for (const e of eventos) {
    const esCargo = e.tipo === "FACTURA";
    saldo = r2(saldo + (esCargo ? e.monto : -e.monto));
    if (e.fecha < desde) {
      saldoInicial = saldo;
      continue;
    }
    if (e.fecha > hasta) break;
    if (esCargo) cargos = r2(cargos + e.monto);
    else abonos = r2(abonos + e.monto);
    if (e.tipo === "NOTA_CREDITO") notasCreditoPeriodo = r2(notasCreditoPeriodo + e.monto);
    movimientos.push({
      fecha: dia(e.fecha),
      tipo: e.tipo,
      referencia: e.referencia,
      cargo: esCargo ? e.monto : 0,
      abono: esCargo ? 0 : e.monto,
      saldo,
    });
  }
  const saldoFinal = movimientos.length > 0 ? movimientos[movimientos.length - 1].saldo : saldoInicial;

  // Facturas abiertas AL CORTE (hasta): cobrado bancario por factura.
  const cobradoPorFactura = new Map<string, number>();
  for (const c of cobros) {
    if (c.fecha > hasta) continue;
    cobradoPorFactura.set(c.invoiceId, r2((cobradoPorFactura.get(c.invoiceId) ?? 0) + c.monto));
  }
  const abiertas: FacturaAbierta[] = [];
  const aging: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let repSinBanco = 0;
  for (const f of facturas) {
    if (f.esNotaCredito || f.fecha > hasta) continue;
    const cobrado = Math.min(cobradoPorFactura.get(f.id) ?? 0, f.total);
    const saldoF = r2(f.total - cobrado);
    if (saldoF <= 0.005) continue;
    const dias = Math.max(0, Math.floor((hoy.getTime() - f.fecha.getTime()) / 86400000));
    const bucket: AgingBucket = dias <= 30 ? "0-30" : dias <= 60 ? "31-60" : dias <= 90 ? "61-90" : "90+";
    aging[bucket] = r2(aging[bucket] + saldoF);
    const repEmitido = !!f.uuid && repsPorUuid.has(f.uuid);
    if (repEmitido) repSinBanco++;
    abiertas.push({
      fecha: dia(f.fecha),
      referencia: f.referencia,
      uuid: f.uuid,
      total: f.total,
      cobrado,
      saldo: saldoF,
      diasVencida: dias,
      repEmitido,
    });
  }
  abiertas.sort((a, b) => a.fecha.localeCompare(b.fecha));

  if (repSinBanco > 0) {
    avisos.push(
      `${repSinBanco} factura(s) abiertas tienen complemento de pago (REP) emitido pero SIN cobro bancario conciliado — concíliales su depósito o revisa si el REP se emitió por error.`,
    );
  }
  if (notasCreditoPeriodo > 0.005) {
    avisos.push(
      "Las notas de crédito abonan al saldo general del cliente; no se aplican contra facturas específicas en este estado de cuenta.",
    );
  }

  return { saldoInicial, cargos, abonos, saldoFinal, movimientos, abiertas, aging, notasCreditoPeriodo, avisos };
}

export interface EstadoDeCuenta extends EstadoDeCuentaData {
  cliente: { razonSocial: string; rfc: string };
  empresa: { razonSocial: string; rfc: string };
  desde: string;
  hasta: string;
  generado: string;
}

/** Carga la historia del cliente y arma el estado de cuenta al corte. */
export async function estadoDeCuentaCliente(
  companyId: string,
  customerId: string,
  opts: { desde: Date; hasta: Date; hoy?: Date },
): Promise<EstadoDeCuenta> {
  const hoy = opts.hoy ?? new Date();
  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { razonSocial: true, rfc: true } }),
    prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { razonSocial: true, rfc: true },
    }),
  ]);
  if (!company) throw new Error("Empresa no encontrada");
  if (!customer) throw new Error("Cliente no encontrado");

  const facturasRows = await prisma.invoice.findMany({
    where: { companyId, customerId, tipo: "INGRESO", status: "STAMPED" },
    select: { id: true, uuid: true, fecha: true, serie: true, folio: true, total: true, tipoSat: true },
    orderBy: { fecha: "asc" },
  });
  const facturas: FacturaInput[] = facturasRows.map((f) => ({
    id: f.id,
    uuid: f.uuid,
    fecha: f.fecha,
    referencia: `${f.serie ?? ""}${f.folio ?? ""}`.trim() || (f.uuid ? f.uuid.slice(0, 8) : f.id.slice(0, 8)),
    total: Number(f.total),
    esNotaCredito: esComprobanteDeEgreso({ tipoSat: f.tipoSat }),
  }));
  const ids = facturas.map((f) => f.id);
  const uuids = facturas.flatMap((f) => (f.uuid ? [f.uuid] : []));

  // Cobros con evidencia bancaria: match 1:1 y conciliación 1-a-varios.
  const [directos, detalles, reps] = await Promise.all([
    ids.length
      ? prisma.bankTransaction.findMany({
          where: { companyId, status: "MATCHED", invoiceId: { in: ids }, monto: { gt: 0 } },
          select: { fecha: true, descripcion: true, invoiceId: true, monto: true },
        })
      : [],
    ids.length
      ? prisma.conciliacionDetalle.findMany({
          // Misma regla que el motor de posteo: el match 1:1 (invoiceId) manda;
          // los detalles sólo aplican cuando el movimiento no tiene invoiceId —
          // sin este filtro, un cobro contaría doble.
          where: {
            invoiceId: { in: ids },
            bankTransaction: { companyId, status: "MATCHED", monto: { gt: 0 }, invoiceId: null },
          },
          select: {
            invoiceId: true,
            montoAsignado: true,
            bankTransaction: { select: { fecha: true, descripcion: true } },
          },
        })
      : [],
    uuids.length
      ? prisma.pagoDoctoRelacionado.findMany({
          where: { parentUuid: { in: uuids }, impPagado: { gt: 0 }, pagoInvoice: { companyId, status: "STAMPED" } },
          select: { parentUuid: true },
        })
      : [],
  ]);
  const cobros: CobroInput[] = [
    ...directos.map((d) => ({
      fecha: d.fecha,
      descripcion: d.descripcion || "Cobro",
      invoiceId: d.invoiceId!,
      monto: Number(d.monto),
    })),
    ...detalles.flatMap((d) =>
      d.invoiceId
        ? [{
            fecha: d.bankTransaction.fecha,
            descripcion: d.bankTransaction.descripcion || "Cobro",
            invoiceId: d.invoiceId,
            monto: Math.abs(Number(d.montoAsignado)),
          }]
        : [],
    ),
  ];

  const data = armarEstadoDeCuenta({
    facturas,
    cobros,
    repsPorUuid: new Set(reps.map((r) => r.parentUuid)),
    desde: opts.desde,
    hasta: opts.hasta,
    hoy,
  });

  return {
    ...data,
    cliente: { razonSocial: customer.razonSocial, rfc: customer.rfc },
    empresa: { razonSocial: company.razonSocial, rfc: company.rfc },
    desde: dia(opts.desde),
    hasta: dia(opts.hasta),
    generado: dia(hoy),
  };
}

/**
 * Saldo por cobrar POR CLIENTE, batcheado para el Directorio (3 queries para
 * toda la cartera de clientes — jamás un estado de cuenta por fila). MISMAS
 * reglas que el estado de cuenta de arriba: cargos = INGRESO timbrado (las
 * notas de crédito, tipoSat E, restan); abonos = cobros con evidencia
 * bancaria — match 1:1 manda y los detalles sólo aplican si el movimiento no
 * tiene invoiceId (regla de precedencia del motor). Los REP no son cobro.
 */
export async function saldosPorCliente(companyId: string): Promise<Map<string, number>> {
  const facturas = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: "STAMPED", customerId: { not: null } },
    select: { id: true, customerId: true, total: true, tipoSat: true },
  });
  const ids = facturas.map((f) => f.id);
  const [directos, detalles] = await Promise.all([
    ids.length
      ? prisma.bankTransaction.findMany({
          where: { companyId, status: "MATCHED", invoiceId: { in: ids }, monto: { gt: 0 } },
          select: { invoiceId: true, monto: true },
        })
      : [],
    ids.length
      ? prisma.conciliacionDetalle.findMany({
          where: {
            invoiceId: { in: ids },
            bankTransaction: { companyId, status: "MATCHED", monto: { gt: 0 }, invoiceId: null },
          },
          select: { invoiceId: true, montoAsignado: true },
        })
      : [],
  ]);

  const clienteDe = new Map<string, string>();
  const saldos = new Map<string, number>();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const f of facturas) {
    const cid = f.customerId as string;
    clienteDe.set(f.id, cid);
    const cargo = esComprobanteDeEgreso({ tipoSat: f.tipoSat }) ? -Number(f.total) : Number(f.total);
    saldos.set(cid, r2((saldos.get(cid) ?? 0) + cargo));
  }
  for (const d of directos) {
    const cid = clienteDe.get(d.invoiceId as string);
    if (cid) saldos.set(cid, r2((saldos.get(cid) ?? 0) - Math.abs(Number(d.monto))));
  }
  for (const d of detalles) {
    const cid = clienteDe.get(d.invoiceId);
    if (cid) saldos.set(cid, r2((saldos.get(cid) ?? 0) - Math.abs(Number(d.montoAsignado))));
  }
  return saldos;
}
