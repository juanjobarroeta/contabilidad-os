// ─────────────────────────────────────────────────────────────────────────────
// Derivación de REFACCIONES desde CFDIs (fase 4) — mismo contrato que
// auto-vehiculo: "solo corre", idempotente, jamás postea al mayor.
//
//   • EGRESO (compra a proveedor)  → ENTRADA_COMPRA por número de parte.
//   • INGRESO (mostrador / taller) → SALIDA_VENTA por número de parte.
//
// Qué cuenta como refacción: un concepto con NoIdentificacion (número de
// parte) y Cantidad, que NO es una unidad (sin complemento VentaVehiculos ni
// candados de unidad), NO menciona VIN (eso es costo de una unidad) y NO es
// un servicio (claves 78xx-95xx) ni un identificador genérico (TRASLADO,
// SEGURO…). Además, el CFDI debe tener AL MENOS `MIN_LINEAS` conceptos con
// número de parte — las facturas de refacciones son multi-línea; exigirlo
// evita convertir folios sueltos en partes fantasma.
//
// Idempotencia: un movimiento por (refacción, CFDI, tipo); las líneas
// repetidas del mismo CFDI se agregan (cantidades sumadas, monto promedio
// ponderado) antes de escribir.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { extraerDatosVehiculoCfdi, tipoComprobanteDesdeCfdi } from "./vin";

type Db = PrismaClient | Prisma.TransactionClient;

export const MIN_LINEAS_REFACCION = 3;

// Claves de SERVICIO (transporte, mantenimiento, financieros, etc.) — un
// NoIdentificacion en estas clases es folio interno, no número de parte.
const CLAVE_SERVICIO_RE = /^(7[89]|8[0-9]|9[0-5])/;

// Identificadores genéricos que los emisores usan como NoIdentificacion sin
// ser partes.
const NO_IDENT_RUIDO = new Set([
  "TRASLADO", "SEGURO", "FLETE", "SERVICIO", "MO", "MANO DE OBRA", "N/A",
  "NA", "S/N", "SN", "GENERICO", "VARIOS", "01010101",
]);

export interface LineaRefaccion {
  numeroParte: string;
  descripcion: string | null;
  claveProdServ: string | null;
  cantidad: number;
  montoUnitario: number | null;
  /**
   * ClaveUnidad del SAT de la línea. Sin esto el kardex compara peras con
   * manzanas: los lubricantes se COMPRAN por tambo (208 L) y se VENDEN por
   * litro, así que el «último costo» de la compra es 208 veces el costo real
   * de lo que sale. Guardarla permite saber cuándo el costo NO es comparable.
   */
  claveUnidad: string | null;
}

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
};

const CONCEPTO_RE =
  /<(?:[\w-]+:)?Concepto\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w-]+:)?Concepto>)/gi;

/**
 * Conceptos de refacción de un CFDI. Reusa el extractor de vehículos para
 * saber qué conceptos son unidades o costos por VIN (esos NO son refacciones).
 */
export function extraerRefaccionesCfdi(rawXml: string): LineaRefaccion[] {
  const datosVehiculo = extraerDatosVehiculoCfdi(rawXml);
  const nivsUnidades = new Set(datosVehiculo.vehiculos.map((v) => v.niv));

  const lineas: LineaRefaccion[] = [];
  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    const noIdent = attr(attrs, "NoIdentificacion")?.trim();
    if (!noIdent || noIdent.length < 2 || noIdent.length > 40) continue;
    if (NO_IDENT_RUIDO.has(noIdent.toUpperCase())) continue;

    const descripcion = attr(attrs, "Descripcion");
    const claveProdServ = attr(attrs, "ClaveProdServ");
    if (claveProdServ && CLAVE_SERVICIO_RE.test(claveProdServ)) continue;

    // Unidades y costos por VIN no son refacciones.
    const texto = `${descripcion ?? ""} ${noIdent}`.toUpperCase();
    if ([...nivsUnidades].some((niv) => texto.includes(niv))) continue;
    const inner = m[3] ?? "";
    if (/<(?:[\w-]+:)?VentaVehiculos\b/i.test(inner)) continue;
    // VIN suelto en la línea → costo de unidad, no refacción de mostrador.
    if (/\b[A-HJ-NPR-Z0-9]{17}\b/.test(texto)) continue;

    const cantidad = Number(attr(attrs, "Cantidad") ?? "1");
    const valorUnitario = Number(attr(attrs, "ValorUnitario") ?? "");
    const importe = Number(attr(attrs, "Importe") ?? "");
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue;

    lineas.push({
      numeroParte: noIdent,
      descripcion,
      claveProdServ,
      claveUnidad: attr(attrs, "ClaveUnidad"),
      cantidad,
      montoUnitario: Number.isFinite(valorUnitario)
        ? valorUnitario
        : Number.isFinite(importe)
          ? importe / cantidad
          : null,
    });
  }
  return lineas;
}

export interface DerivarRefaccionesArgs {
  companyId: string;
  invoiceId: string;
  tipo: string; // Invoice.tipo
  fecha: Date;
  rawXml: string | null;
}

export interface DerivarRefaccionesResultado {
  partes: number;
  movimientos: number;
}

/**
 * Deriva catálogo + kardex de un CFDI. Devuelve null si el CFDI no parece
 * factura de refacciones (menos de MIN_LINEAS líneas con número de parte).
 */
export async function derivarRefaccionesDesdeCfdiSiAplica(
  db: Db,
  args: DerivarRefaccionesArgs
): Promise<DerivarRefaccionesResultado | null> {
  if (!args.rawXml) return null;
  const esCompra = args.tipo === "EGRESO";
  const esVenta = args.tipo === "INGRESO";
  if (!esCompra && !esVenta) return null;
  // Notas de crédito: netean dinero, no mueven kardex (v1 — devoluciones después).
  if (tipoComprobanteDesdeCfdi(args.rawXml) === "E") return null;

  const lineas = extraerRefaccionesCfdi(args.rawXml);
  if (lineas.length < MIN_LINEAS_REFACCION) return null;

  // Agrega líneas repetidas del mismo número de parte.
  const porParte = new Map<string, LineaRefaccion>();
  for (const l of lineas) {
    const prev = porParte.get(l.numeroParte);
    if (!prev) {
      porParte.set(l.numeroParte, { ...l });
    } else {
      const total = (prev.montoUnitario ?? 0) * prev.cantidad + (l.montoUnitario ?? 0) * l.cantidad;
      prev.cantidad += l.cantidad;
      prev.montoUnitario = prev.cantidad > 0 ? Math.round((total / prev.cantidad) * 100) / 100 : null;
      prev.descripcion = prev.descripcion ?? l.descripcion;
      prev.claveUnidad = prev.claveUnidad ?? l.claveUnidad;
    }
  }

  const tipoMov = esCompra ? ("ENTRADA_COMPRA" as const) : ("SALIDA_VENTA" as const);
  let partes = 0;
  let movimientos = 0;

  for (const l of porParte.values()) {
    const refaccion = await db.refaccion.upsert({
      where: { companyId_numeroParte: { companyId: args.companyId, numeroParte: l.numeroParte } },
      create: {
        companyId: args.companyId,
        numeroParte: l.numeroParte,
        descripcion: (l.descripcion ?? l.numeroParte).slice(0, 200),
        claveProdServ: l.claveProdServ,
        ...(esCompra
          ? { ultimoCosto: l.montoUnitario ?? 0, unidadCosto: l.claveUnidad }
          : { ultimoPrecio: l.montoUnitario, unidadPrecio: l.claveUnidad }),
      },
      update: esCompra
        ? { ultimoCosto: l.montoUnitario ?? undefined, unidadCosto: l.claveUnidad ?? undefined }
        : { ultimoPrecio: l.montoUnitario ?? undefined, unidadPrecio: l.claveUnidad ?? undefined },
      select: { id: true },
    });
    partes++;

    // Idempotente por (refacción, CFDI, tipo).
    const ya = await db.refaccionMovimiento.findUnique({
      where: {
        refaccionId_invoiceId_tipo: {
          refaccionId: refaccion.id,
          invoiceId: args.invoiceId,
          tipo: tipoMov,
        },
      },
      select: { id: true },
    });
    if (ya) continue;
    await db.refaccionMovimiento.create({
      data: {
        refaccionId: refaccion.id,
        invoiceId: args.invoiceId,
        tipo: tipoMov,
        cantidad: esCompra ? l.cantidad : -l.cantidad,
        montoUnitario: l.montoUnitario,
        fecha: args.fecha,
      },
    });
    movimientos++;
  }

  return { partes, movimientos };
}
