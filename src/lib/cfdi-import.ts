import { prisma } from "./prisma";
import { parseCfdiXml } from "./sat-fiel";
import { clasificarCfdi } from "./fiscal/clasificar-cfdi";
import { parchearClienteDesdeCfdi } from "./facturas/cliente-fiscal-repo";
import { identidadDesdeCfdi, regimenParaAlta } from "./facturas/identidad-receptor";
import { crearActivoDesdeCfdiSiAplica } from "./fiscal/auto-activo";
import { derivarVehiculoInline } from "./automotriz/auto-vehiculo";

// ─────────────────────────────────────────────────────────────────────────────
// Importar UN CFDI a partir de su XML — sin importar de dónde vino.
//
// POR QUÉ EXISTE. Esto vivía INLINE dentro de `verifyAndImportSatSync`, metido
// en un doble `for` sobre los paquetes que devuelve la descarga masiva. Ahí
// funcionaba bien, pero sólo se podía llegar por esa puerta: la del SAT.
//
// El SAT topa los CFDIs a CINCO AÑOS. MARGOM opera desde 2017-08, así que
// 2017–2021 no es que no lo hayamos pedido — no se puede pedir. Syntage sí
// sirve esos años, y trae el XML tal cual lo timbró el SAT (`xml: true`).
//
// Extraerlo tal cual —MISMO código, no una segunda versión parecida— es lo que
// hace que un CFDI de 2018 que llega por Syntage quede EXACTAMENTE igual que
// uno de 2024 que llegó por el SAT: mismo mapeo de TipoDeComprobante, misma
// contraparte, misma clasificación, mismo activo fijo, mismo vehículo, mismos
// links de complemento de pago. Un importador paralelo habría sido un segundo
// juego de reglas divergiendo en silencio — que es justo como se catalogan mal
// las cosas.
//
// DUPLICADOS. No dependen de este código: `Invoice` tiene
// `@@unique([companyId, uuid])`, así que Postgres rechaza un folio fiscal
// repetido venga de donde venga. La consulta de `existing` que hay aquí es para
// no re-trabajar y para REPARAR filas viejas (rawXml faltante, régimen de
// nómina, desglose de impuestos, links de pago), no para evitar el duplicado.
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde llegó el XML. Sólo cambia la nota de auditoría en la factura. */
export type OrigenCfdi = "SAT" | "Syntage";

/** Emitidos = nosotros facturamos; recibidos = nos facturaron. */
export type DireccionCfdi = "emitidos" | "recibidos";

export interface ImportarCfdiArgs {
  companyId: string;
  /** RFC de la empresa: decide si somos emisor cuando el tipo no lo dice. */
  rfcEmpresa: string | null;
  /**
   * De qué lado viene. La descarga masiva del SAT lo sabe —pide emitidos y
   * recibidos por separado, en paquetes distintos— así que lo pasa. Syntage
   * devuelve las dos en la MISMA colección, así que pasa `null` y la dirección
   * se decide comparando el RFC del emisor contra el nuestro.
   */
  tipo: DireccionCfdi | null;
  /** Folio fiscal como venga; aquí se normaliza. */
  rawUuid: string;
  xmlContent: string;
  origen: OrigenCfdi;
}

export type ResultadoImportacion =
  /** Ya lo teníamos. Puede haberse reparado (rawXml, nómina, impuestos, pagos). */
  | { resultado: "existente" }
  /** El XML no trae folio fiscal o fecha: no se puede guardar como comprobante. */
  | { resultado: "invalido" }
  /**
   * Se creó la factura. `periodoAfectado` ("2024-1") viene sólo para los tipos
   * que el motor de posteo consume — es lo que dispara el auto-cierre del mes.
   */
  | { resultado: "importado"; periodoAfectado: string | null };

/** TipoDeComprobante del SAT → nuestro enum. */
const SAT_TIPO_MAP: Record<string, "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO"> = {
  I: "INGRESO",
  E: "EGRESO",
  N: "NOMINA",
  P: "PAGO",
  T: "TRASLADO",
};

export async function importarCfdiXml(args: ImportarCfdiArgs): Promise<ResultadoImportacion> {
  const { companyId, rfcEmpresa, tipo, rawUuid, xmlContent, origen } = args;

  // Folio fiscal canónico en MAYÚSCULAS. La dedup empata sin distinguir
  // caja (mode: insensitive) para reconocer copias previas guardadas en
  // minúsculas (p.ej. timbradas por el PAC) y NO duplicarlas.
  const uuid = rawUuid.trim().toUpperCase();

  // Already in DB: skip — but backfill rawXml and the per-tax desglose if
  // they're missing, so a re-sync repairs CFDIs imported before we stored
  // the file / parsed the <cfdi:Impuestos> node.
  const existing = await prisma.invoice.findFirst({
    where: { companyId, uuid: { equals: uuid, mode: "insensitive" } },
    select: {
      id: true,
      tipo: true,
      rawXml: true,
      regimenNomina: true,
      _count: { select: { taxes: true, doctosRelacionados: true } },
    },
  });
  if (existing) {
    if (!existing.rawXml) {
      await prisma.invoice.update({ where: { id: existing.id }, data: { rawXml: xmlContent } });
    }
    // Repara el régimen/ISR retenido de nómina de filas importadas antes de
    // parsear el complemento (incl. las que no tenían rawXml): así un re-sync
    // del periodo las reconoce como asimilados sin pasos manuales.
    if (existing.tipo === "NOMINA" && existing.regimenNomina == null) {
      const parsed = parseCfdiXml(xmlContent);
      if (parsed.nomina?.tipoRegimen) {
        await prisma.invoice.update({
          where: { id: existing.id },
          data: {
            regimenNomina: parsed.nomina.tipoRegimen,
            tipoNomina: parsed.nomina.tipoNomina ?? null,
            isrRetenidoNomina: parsed.nomina.isrRetenido ?? null,
          },
        });
      }
    }
    if (existing._count.taxes === 0) {
      const parsed = parseCfdiXml(xmlContent);
      if (parsed.taxes.length > 0) {
        await prisma.invoiceTax.createMany({
          data: parsed.taxes.map((t) => ({ invoiceId: existing.id, ...t })),
        });
      }
    }
    // Backfill de los links del complemento de pago (DoctoRelacionado) de un
    // REP importado antes de que parseáramos el complemento (o si su creación
    // falló). Sin estos links, el IVA del pago — que para PPD se causa al
    // cobrarse — nunca se reconoce. Idempotente: sólo cuando no hay ninguno.
    if (existing.tipo === "PAGO" && existing._count.doctosRelacionados === 0) {
      const parsed = parseCfdiXml(xmlContent);
      if (parsed.doctosRelacionados?.length) {
        await prisma.pagoDoctoRelacionado.createMany({
          data: parsed.doctosRelacionados.map((d) => ({
            pagoInvoiceId: existing.id,
            parentUuid: d.uuid,
            impPagado: d.impPagado,
            numParcialidad: d.numParcialidad != null ? Math.trunc(d.numParcialidad) : null,
            impSaldoAnterior: d.impSaldoAnterior,
            impSaldoInsoluto: d.impSaldoInsoluto,
            fechaPago: d.fechaPago ? new Date(d.fechaPago) : null,
            baseTraslado: d.baseTraslado,
            ivaTrasladado: d.ivaTrasladado,
            ivaDerivado: d.ivaDerivado,
          })),
          skipDuplicates: true,
        });
      }
    }
    return { resultado: "existente" };
  }

  const cfdi = parseCfdiXml(xmlContent);
  if (!cfdi.uuid || !cfdi.fecha) {
    return { resultado: "invalido" };
  }

  // Map SAT TipoDeComprobante (I/E/N/P/T) to our InvoiceType enum.
  // If for some reason it's missing, fall back to direction-based guess.
  const isEmisor = tipo === "emitidos" || cfdi.rfcEmisor === rfcEmpresa;
  const mappedType = cfdi.tipo ? SAT_TIPO_MAP[cfdi.tipo] : undefined;
  // TipoDeComprobante I/E is the ISSUER's perspective — a supplier's
  // "I" sales invoice in our RECIBIDOS bucket is OUR expense. Only N/P/T
  // are standalone categories; for I/E follow emisor-vs-receptor.
  const invoiceType: "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO" =
    mappedType === "NOMINA" || mappedType === "PAGO" || mappedType === "TRASLADO"
      ? mappedType
      : isEmisor ? "INGRESO" : "EGRESO";

  // Find or create counterparty customer record
  const counterpartyRfc = isEmisor ? cfdi.rfcReceptor : cfdi.rfcEmisor;
  const counterpartyName = isEmisor ? cfdi.nombreReceptor : cfdi.nombreEmisor;

  let customerId: string | null = null;
  if (
    counterpartyRfc &&
    counterpartyRfc !== "XAXX010101000" &&
    counterpartyRfc !== "XEXX010101000"
  ) {
    const existingCustomer = await prisma.customer.findFirst({
      where: { companyId, rfc: counterpartyRfc },
    });
    if (existingCustomer) {
      customerId = existingCustomer.id;
      // Rellena CP/régimen faltantes con los del comprobante, sin pisar nunca
      // lo capturado a mano. Así el padrón de clientes se completa solo
      // conforme entra el histórico.
      await parchearClienteDesdeCfdi(existingCustomer.id, cfdi, isEmisor);
    } else if (counterpartyName) {
      try {
        // Identidad fiscal EXACTA del receptor: un CFDI timbrado ya pasó la
        // validación del padrón (RFC + Nombre + DomicilioFiscalReceptor). Antes
        // se guardaba régimen "616" y sin CP, y después no se le podía facturar
        // a ese cliente sin capturar sus datos a mano.
        const ident = identidadDesdeCfdi(cfdi, isEmisor);
        const newCustomer = await prisma.customer.create({
          data: {
            companyId,
            rfc: counterpartyRfc,
            razonSocial: counterpartyName,
            regimenFiscal: regimenParaAlta({
              esEmitida: isEmisor,
              regimenFiscalReceptor: cfdi.regimenFiscalReceptor,
              regimenEmisor: cfdi.regimenEmisor,
            }),
            ...(ident.codigoPostal ? { codigoPostal: ident.codigoPostal } : {}),
          },
        });
        customerId = newCustomer.id;
      } catch {
        /* ignore duplicate RFC */
      }
    }
  }

  const clasif = clasificarCfdi({
    tipo: invoiceType,
    usoCfdi: cfdi.usoCfdi ?? null,
    usoEsDefault: !cfdi.usoCfdi,
    items: (cfdi.items ?? []).map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe })),
  });

  const createdInvoice = await prisma.invoice.create({
    data: {
      companyId,
      customerId,
      // Contraparte del comprobante: se guarda SIEMPRE, haya Customer o
      // no (público en general y extranjeros no lo tienen a propósito).
      contraparteNombre: counterpartyName ?? null,
      contraparteRfc: counterpartyRfc ?? null,
      tipo: invoiceType,
      // TipoDeComprobante crudo del SAT: "E" marca nota de credito y el
      // motor fiscal la netea con signo negativo dentro de su tipo.
      tipoSat: cfdi.tipo ?? null,
      // A qué comprobante apunta éste. Hasta ahora estas dos columnas
      // sólo las escribía el módulo que EMITE notas de crédito desde la
      // app, así que todo lo importado del SAT las tenía en null y
      // cualquier regla que dependiera de la relación quedaba inerte.
      // Un CFDI puede traer varias relaciones; en las columnas cabe una,
      // y el resto sigue disponible en el rawXml que se guarda íntegro.
      tipoRelacion: cfdi.relacionados[0]?.tipoRelacion ?? null,
      cfdiRelacionadoUuid: cfdi.relacionados[0]?.uuids[0] ?? null,
      fecha: new Date(cfdi.fecha),
      serie: cfdi.serie ?? null,
      folio: cfdi.folio ?? null,
      formaPago: cfdi.formaPago ?? "99",
      metodoPago: cfdi.metodoPago ?? "PUE",
      usoCfdi: cfdi.usoCfdi ?? "G03",
      naturaleza: clasif.fuente === "no_aplica" ? null : clasif.naturaleza,
      naturalezaRevision: clasif.requiereRevision,
      // Complemento de nómina (CFDI tipo "N"): régimen del receptor + ISR
      // retenido — null para CFDIs que no son nómina.
      regimenNomina: cfdi.nomina?.tipoRegimen ?? null,
      tipoNomina: cfdi.nomina?.tipoNomina ?? null,
      isrRetenidoNomina: cfdi.nomina?.isrRetenido ?? null,
      moneda: cfdi.moneda ?? "MXN",
      subtotal: cfdi.subtotal,
      total: cfdi.total,
      totalImpuestos: cfdi.ivaTotal,
      status: "STAMPED",
      uuid,
      rawXml: xmlContent, // keep the authentic CFDI so we can re-send it
      // Nota de auditoría: de dónde vino y de qué lado. Cuando el origen no
      // separa emitidas de recibidas (Syntage), se etiqueta con lo que resultó
      // de comparar el RFC del emisor.
      notas: `${origen} — ${tipo ?? (isEmisor ? "emitidos" : "recibidos")}`,
      items:
        cfdi.items && cfdi.items.length > 0
          ? {
              create: cfdi.items.map((it) => ({
                cantidad: it.cantidad,
                claveUnidad: it.claveUnidad,
                unidad: it.unidad,
                claveProdServ: it.claveProdServ,
                descripcion: it.descripcion,
                valorUnitario: it.valorUnitario,
                importe: it.importe,
                descuento: it.descuento,
              })),
            }
          : undefined,
      // Desglose real del nodo <cfdi:Impuestos> (traslados con factor
      // Tasa/Exento + retenciones IVA/ISR) — alimenta retenciones
      // acreditadas y la proporción de acreditamiento (Art. 5 LIVA).
      taxes: cfdi.taxes.length > 0 ? { create: cfdi.taxes } : undefined,
    },
  });

  // Auto-registro de activo fijo si el CFDI es inversión (naturaleza
  // INVERSION) — depreciación sin captura manual; el contador sólo revisa.
  await crearActivoDesdeCfdiSiAplica(prisma, {
    companyId,
    invoiceId: createdInvoice.id,
    subtotal: cfdi.subtotal,
    fecha: new Date(cfdi.fecha),
    descripcion: cfdi.items?.[0]?.descripcion,
    clasifInput: {
      tipo: invoiceType,
      usoCfdi: cfdi.usoCfdi ?? null,
      usoEsDefault: !cfdi.usoCfdi,
      items: (cfdi.items ?? []).map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe })),
    },
  });

  // Inventario automotriz inline (complemento VentaVehiculos / clave
  // 2510xx): la unidad aparece junto con su CFDI. Sólo empresas con el
  // módulo AUTOMOTRIZ; el cron vehiculos-backfill es la red de seguridad.
  await derivarVehiculoInline(prisma, {
    companyId,
    invoiceId: createdInvoice.id,
    tipo: invoiceType,
    fecha: new Date(cfdi.fecha),
    rawXml: xmlContent,
    clienteId: invoiceType === "INGRESO" ? customerId : null,
    total: cfdi.total,
    subtotal: cfdi.subtotal,
  });

  // Persist complemento de pago links (DoctoRelacionado parent UUIDs).
  if (invoiceType === "PAGO" && cfdi.doctosRelacionados?.length) {
    await prisma.pagoDoctoRelacionado.createMany({
      data: cfdi.doctosRelacionados.map((d) => ({
        pagoInvoiceId: createdInvoice.id,
        parentUuid: d.uuid,
        impPagado: d.impPagado,
        numParcialidad: d.numParcialidad != null ? Math.trunc(d.numParcialidad) : null,
        impSaldoAnterior: d.impSaldoAnterior,
        impSaldoInsoluto: d.impSaldoInsoluto,
        fechaPago: d.fechaPago ? new Date(d.fechaPago) : null,
        baseTraslado: d.baseTraslado,
        ivaTrasladado: d.ivaTrasladado,
        ivaDerivado: d.ivaDerivado,
      })),
      skipDuplicates: true,
    });
  }

  // Sólo los tipos que el motor de posteo consume disparan auto-cierre.
  const f = new Date(cfdi.fecha);
  const periodoAfectado =
    invoiceType === "INGRESO" || invoiceType === "EGRESO" || invoiceType === "NOMINA"
      ? `${f.getUTCFullYear()}-${f.getUTCMonth() + 1}`
      : null;

  return { resultado: "importado", periodoAfectado };
}
