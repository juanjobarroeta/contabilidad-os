// ─────────────────────────────────────────────────────────────────────────────
// Complemento de Pago (REP 2.0) — EMISIÓN (parte servidor).
//
// Usa el núcleo puro `complementos-rep.ts` para la aritmética fiscal (parcialidad,
// saldos, desglose de IVA) y aquí se ocupa de: readiness (mismo estándar que el
// timbrado normal), guardas de alcance (MXN y un solo padre por ahora), llamada a
// Facturapi (type "P" + complemento "pago") y persistencia CONSISTENTE (Invoice
// tipo PAGO + una fila PagoDoctoRelacionado, que es lo que lee el motor de IVA).
//
// NO hace auth: el llamador (ruta web o riel Tier 3) ya validó sesión, membresía y
// gating de suscripción. Devuelve un resultado discriminado para mapear a HTTP.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { recordTimbrado } from "@/lib/costos/record";
import { checkStampReadiness } from "@/lib/facturas/stamp";
import { computeRepDoctoRelacionado, round2, sintetizarParentTaxes, type RepParentTax, type RepDoctoRelacionado } from "@/lib/complementos-rep";

export interface EmitirRepInput {
  companyId: string;
  /** Factura PPD de ingreso que se está pagando. */
  invoiceId: string;
  /** Movimiento bancario del pago (de él se toma monto/fecha si no vienen). */
  bankTransactionId?: string;
  /** Monto del pago; si falta, se toma del movimiento bancario. */
  monto?: number;
  /** Fecha del pago (ISO); si falta, la del movimiento bancario o hoy. */
  fechaPago?: string;
  /** Forma de pago SAT (01/03/…); default "03" (transferencia). */
  formaPago?: string;
}

export type EmitirRepResult =
  | { ok: true; uuid: string; monto: number; parentUuid: string; numParcialidad: number }
  | { ok: false; status: number; error: string };

/** Resumen para la pantalla de revisión (Tier 3) sin re-timbrar. */
export interface RepPreview {
  invoiceId: string;
  parentUuid: string;
  cliente: string;
  rfc: string;
  monto: number;
  fechaPago: string;
  numParcialidad: number;
  impSaldoAnterior: number;
  impSaldoInsoluto: number;
  ivaTrasladado: number;
}

/** Carga el padre + insumos y calcula la parcialidad SIN emitir (para preview). */
export async function prepararRep(
  input: EmitirRepInput
): Promise<
  | { ok: true; preview: RepPreview }
  | { ok: false; status: number; error: string }
> {
  const ctx = await cargarContexto(input);
  if (!ctx.ok) return ctx;
  const { parentInv, docto, paymentAmount, paymentDate } = ctx;
  return {
    ok: true,
    preview: {
      invoiceId: parentInv.id,
      parentUuid: parentInv.uuid!,
      cliente: parentInv.customer?.razonSocial ?? "—",
      rfc: parentInv.customer?.rfc ?? "—",
      monto: paymentAmount,
      fechaPago: paymentDate.toISOString().slice(0, 10),
      numParcialidad: docto.numParcialidad,
      impSaldoAnterior: docto.impSaldoAnterior,
      impSaldoInsoluto: docto.impSaldoInsoluto,
      ivaTrasladado: docto.ivaTrasladado,
    },
  };
}

/** Emite el REP: valida, timbra en Facturapi y persiste de forma consistente. */
export async function emitirComplementoPago(input: EmitirRepInput): Promise<EmitirRepResult> {
  const ctx = await cargarContexto(input);
  if (!ctx.ok) return ctx;
  const { company, parentInv, docto, paymentAmount, paymentDate, formaPago } = ctx;

  const facturapi = getFacturapiClient(company.facturapiApiKey!, {
    companyId: input.companyId,
    actor: "rep-emit",
  });

  // Sólo los campos documentados por Facturapi para el DoctoRelacionado del
  // complemento de pago: uuid, amount, installment, last_balance, taxes. El
  // validador es estricto ("El campo X no está permitido") — series/folio/
  // taxability/currency del documento se derivan del CFDI padre en su lado, y
  // el Monto del pago se calcula a partir de los related_documents.
  const relatedDoc: Record<string, unknown> = {
    uuid: parentInv.uuid,
    last_balance: docto.impSaldoAnterior,
    amount: docto.impPagado,
    installment: docto.numParcialidad,
  };
  if (docto.objetoImp === "02") {
    relatedDoc.taxes = [...docto.traslados, ...docto.retenciones].map((t) => ({
      type: t.tipo,
      factor: t.factor,
      rate: t.tasa,
      base: t.base,
      withholding: t.retencion,
    }));
  }

  const payload: Record<string, unknown> = {
    type: "P",
    customer: parentInv.customer!.facturapiId,
    complements: [
      {
        type: "pago",
        // `data` es un ARREGLO de pagos (un REP puede amparar varios); sin
        // `amount` a nivel pago — Facturapi lo deriva de los documentos.
        data: [
          {
            payment_form: formaPago,
            currency: parentInv.moneda ?? "MXN",
            date: paymentDate.toISOString().slice(0, 10),
            related_documents: [relatedDoc],
          },
        ],
      },
    ],
  };

  let result: { id?: string; uuid?: string; series?: string; folio_number?: number };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = (await facturapi.invoices.create(payload as any)) as any;
  } catch (e) {
    console.error("[complemento-pago] Facturapi error", e);
    return { ok: false, status: 502, error: e instanceof Error ? e.message : "Error al emitir el complemento de pago." };
  }
  if (!result?.uuid) {
    return { ok: false, status: 502, error: "Facturapi no devolvió folio fiscal del complemento." };
  }

  void recordTimbrado("pago", 1, { companyId: input.companyId, subtipo: "complemento_pagos" });

  // Persistencia consistente: la factura PAGO (misma convención que el detector:
  // notas=id del padre, total=monto pagado) + la fila PagoDoctoRelacionado (que
  // el motor de IVA lee para atribuir el IVA al periodo del pago).
  try {
    await prisma.$transaction(async (tx) => {
      const rep = await tx.invoice.create({
        data: {
          companyId: input.companyId,
          tipo: "PAGO",
          serie: result.series ?? null,
          folio: result.folio_number ? String(result.folio_number) : null,
          fecha: paymentDate,
          formaPago,
          metodoPago: "PUE",
          usoCfdi: "CP01",
          moneda: parentInv.moneda ?? "MXN",
          subtotal: 0,
          total: docto.impPagado,
          status: "STAMPED",
          uuid: result.uuid!.toUpperCase(),
          facturapiId: result.id ?? null,
          customerId: parentInv.customerId,
          notas: parentInv.id, // enlace al padre (convención del detector de emitidos)
        },
        select: { id: true },
      });
      await tx.pagoDoctoRelacionado.create({
        data: {
          pagoInvoiceId: rep.id,
          parentUuid: parentInv.uuid!,
          impPagado: docto.impPagado,
          numParcialidad: docto.numParcialidad,
          impSaldoAnterior: docto.impSaldoAnterior,
          impSaldoInsoluto: docto.impSaldoInsoluto,
          fechaPago: paymentDate,
          baseTraslado: docto.baseTrasladoIva || null,
          ivaTrasladado: docto.ivaTrasladado || null,
          ivaDerivado: false,
        },
      });
    });
  } catch (e) {
    // El CFDI YA se timbró en el SAT; falló solo la persistencia local. No es un
    // fallo del timbrado — se avisa para reconciliar, nunca se re-timbra.
    console.error("[complemento-pago] timbrado OK pero falló la persistencia local", e);
    return {
      ok: false,
      status: 500,
      error: `El complemento se timbró (folio ${result.uuid}) pero no se pudo guardar localmente. Sincroniza con el SAT para reflejarlo; no lo vuelvas a emitir.`,
    };
  }

  return { ok: true, uuid: result.uuid, monto: docto.impPagado, parentUuid: parentInv.uuid!, numParcialidad: docto.numParcialidad };
}

// ── Contexto compartido: carga + validación + cálculo (sin emitir) ───────────

type Contexto =
  | {
      ok: true;
      company: { facturapiApiKey: string | null };
      parentInv: {
        id: string;
        uuid: string | null;
        serie: string | null;
        folio: string | null;
        total: number;
        subtotal: number;
        moneda: string;
        customerId: string | null;
        customer: { razonSocial: string; rfc: string; facturapiId: string | null } | null;
      };
      docto: RepDoctoRelacionado;
      paymentAmount: number;
      paymentDate: Date;
      formaPago: string;
    }
  | { ok: false; status: number; error: string };

async function cargarContexto(input: EmitirRepInput): Promise<Contexto> {
  const parentInv = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId, tipo: "INGRESO", metodoPago: "PPD" },
    select: {
      id: true, uuid: true, serie: true, folio: true, total: true, subtotal: true, moneda: true,
      customerId: true,
      customer: { select: { razonSocial: true, rfc: true, facturapiId: true } },
      taxes: { select: { tipo: true, factor: true, tasa: true, base: true, importe: true, retencion: true } },
    },
  });
  if (!parentInv) return { ok: false, status: 404, error: "Factura PPD no encontrada." };
  if (!parentInv.uuid) return { ok: false, status: 400, error: "La factura no está timbrada (sin folio fiscal)." };

  // Alcance por ahora: solo MXN. Una PPD en USD exige TipoCambioP y el tipo de
  // cambio no se persiste en la importación — se difiere para no emitir un REP
  // con un tipo de cambio inventado.
  if ((parentInv.moneda ?? "MXN") !== "MXN") {
    return { ok: false, status: 422, error: `Complemento en ${parentInv.moneda} aún no soportado; emítelo desde el portal del SAT o la app con el tipo de cambio correcto.` };
  }
  if (!parentInv.customerId) {
    return { ok: false, status: 422, error: "La factura no tiene cliente registrado; no se puede emitir el complemento." };
  }

  // Readiness igual que el timbrado normal: CSD listo + cliente sincronizado en
  // Facturapi (con facturapiId). Evita inventar un receptor genérico.
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { facturapiApiKey: true },
  });
  if (!company?.facturapiApiKey) {
    return { ok: false, status: 422, error: "La empresa no está lista para timbrar (configura Facturapi en la app)." };
  }
  const readiness = await checkStampReadiness(input.companyId, parentInv.customerId);
  if (readiness && !readiness.ok) {
    return { ok: false, status: readiness.status, error: readiness.error };
  }

  // Parcialidades previas: sumamos los REP ya emitidos para este padre (misma
  // convención que el detector: Invoice tipo PAGO con notas = id del padre).
  const prev = await prisma.invoice.aggregate({
    where: { companyId: input.companyId, tipo: "PAGO", status: "STAMPED", notas: parentInv.id },
    _sum: { total: true },
    _count: { _all: true },
  });
  const priorImpPagado = prev._sum.total ?? 0;
  const priorCount = prev._count._all;
  const saldoPendiente = round2(parentInv.total - priorImpPagado);

  // Monto y fecha del pago.
  let paymentAmount = input.monto != null ? Number(input.monto) : null;
  let paymentDate = input.fechaPago ? new Date(input.fechaPago) : new Date();
  if (input.bankTransactionId) {
    const bankTx = await prisma.bankTransaction.findFirst({
      where: { id: input.bankTransactionId, companyId: input.companyId },
      select: { monto: true, fecha: true },
    });
    if (!bankTx) return { ok: false, status: 404, error: "Movimiento bancario no encontrado." };
    paymentAmount = paymentAmount ?? Math.abs(bankTx.monto);
    paymentDate = input.fechaPago ? paymentDate : bankTx.fecha;
  }
  // "De un toque": sin monto ni movimiento, se asume el SALDO PENDIENTE completo
  // (el caso común — un pago en una sola exhibición reportado tarde, o la última
  // parcialidad). El motor valida que no exceda el saldo de todas formas.
  if (paymentAmount == null) paymentAmount = saldoPendiente;
  if (!(paymentAmount > 0)) {
    return { ok: false, status: 400, error: "No hay saldo pendiente para emitir el complemento." };
  }

  let parentTaxes: RepParentTax[] = parentInv.taxes.map((t) => ({
    tipo: t.tipo as RepParentTax["tipo"],
    factor: t.factor as RepParentTax["factor"],
    tasa: t.tasa,
    base: t.base,
    importe: t.importe,
    retencion: t.retencion,
  }));
  // Facturas timbradas en la app ANTES de que persistiéramos InvoiceTax: sin
  // filas ni rawXml, el desglose se sintetiza desde los totales cuando el
  // delta corresponde a una tasa de IVA conocida. Si no cuadra, mejor rechazar
  // con un mensaje claro que timbrar un REP con impuestos inventados.
  if (parentTaxes.length === 0) {
    const sintetizadas = sintetizarParentTaxes(parentInv.subtotal, parentInv.total);
    if (sintetizadas === null) {
      return {
        ok: false,
        status: 422,
        error:
          "La factura no tiene el desglose de impuestos guardado y no se pudo derivar de sus totales (mezcla de tasas o retenciones). Sube el XML de la factura en Facturas → Subir XML y vuelve a intentar.",
      };
    }
    parentTaxes = sintetizadas;
  }

  const computed = computeRepDoctoRelacionado({
    parentTotal: parentInv.total,
    parentSubtotal: parentInv.subtotal,
    priorImpPagado,
    priorCount,
    paymentAmount,
    parentTaxes,
  });
  if (!computed.ok) return { ok: false, status: 422, error: computed.error };

  return {
    ok: true,
    company,
    parentInv,
    docto: computed.docto,
    paymentAmount: computed.docto.impPagado,
    paymentDate,
    formaPago: input.formaPago ?? "03",
  };
}
