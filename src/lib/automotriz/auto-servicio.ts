// ─────────────────────────────────────────────────────────────────────────────
// Derivación de VENTAS DE SERVICIO/TALLER desde CFDIs (fase 5, lado lectura).
// Una factura INGRESO es de taller si NO ampara unidades y trae al menos un
// concepto de servicio automotriz (clave 7818xx o texto de servicio). Se
// separa mano de obra vs refacciones por concepto y se liga cliente y — si el
// CFDI menciona el VIN — la unidad. Mismo contrato: idempotente, no postea.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { extraerDatosVehiculoCfdi, tipoComprobanteDesdeCfdi, vinsDesdeTexto } from "./vin";
import { clasificarConcepto } from "./concepto-linea";
import { unidadVigentePorVin } from "./unidad-vigente";

type Db = PrismaClient | Prisma.TransactionClient;

const SERVICIO_TEXTO_RE =
  /\b(SERVICIO|MANTENIMIENTO|REPARACI[OÓ]N|MANO DE OBRA|LAVADO|AFINACI[OÓ]N|ALINEACI[OÓ]N|BALANCEO|DIAGN[OÓ]STICO|HOJALATER[IÍ]A|PINTURA)\b/i;

// ANTICIPOS: el SAT los factura con clave 84111506 y la descripción canónica
// «Anticipo del bien o servicio» (guía de anticipos, Anexo 20). Esa frase
// contiene la palabra SERVICIO, así que el filtro de texto los tomaba por
// órdenes de taller: en Margom un anticipo de $278,000 por una camioneta
// aparecía como la orden de servicio más cara del año. Un anticipo no es venta
// de taller ni refacción — es un cobro a cuenta que la factura final aplica
// (TipoRelacion 07).
const CLAVE_ANTICIPO = "84111506";
const ANTICIPO_TEXTO_RE = /\bANTICIPO\b/i;

// Descripciones que NO dicen qué se hizo: nombrar la orden con ellas deja al
// taller lleno de renglones «mano de obra». En los CFDIs reales conviven una
// línea genérica (a veces de $0.01, de relleno) con las que sí describen el
// trabajo — «instalacion de balatas delanteras», «mantenimiento de sistema de
// urea». La orden se nombra con esas.
const DESCRIPCION_GENERICA_RE =
  /^\s*(mano de obra|m\.?\s*de\s*obra|servicio|servicios|mantenimiento|reparaci[oó]n|otros?)\s*$/i;

const CONCEPTO_RE =
  /<(?:[\w-]+:)?Concepto\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w-]+:)?Concepto>)/gi;

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
};

export interface DatosServicioCfdi {
  esServicio: boolean;
  manoObra: number;
  refacciones: number;
  concepto: string | null;
  vins: string[];
}

/** Clasifica los conceptos de una factura de taller. */
export function extraerServicioCfdi(rawXml: string): DatosServicioCfdi {
  // Si el CFDI ampara una unidad, es venta de vehículo — no taller.
  const datosVehiculo = extraerDatosVehiculoCfdi(rawXml);
  if (datosVehiculo.vehiculos.length > 0) {
    return { esServicio: false, manoObra: 0, refacciones: 0, concepto: null, vins: [] };
  }

  let manoObra = 0;
  let refacciones = 0;
  const vins = new Set<string>();
  let tieneServicio = false;
  const lineasServicio: Array<{ descripcion: string; importe: number }> = [];

  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    const descripcion = attr(attrs, "Descripcion");
    const clave = attr(attrs, "ClaveProdServ") ?? "";
    const noIdent = attr(attrs, "NoIdentificacion");
    const importe = Number(attr(attrs, "Importe") ?? "0") || 0;

    for (const v of vinsDesdeTexto(descripcion)) vins.add(v);

    // La decisión vive en concepto-linea.ts, compartida con el derivador del
    // kardex. Cuando cada uno tenía su propio criterio, un «KIT DE REPARACIÓN
    // DE CALIPER» —parte real, con número de parte— entraba como mano de obra
    // aquí y como refacción allá: el mismo peso en dos líneas del tablero.
    const linea = clasificarConcepto({
      claveProdServ: clave,
      noIdentificacion: noIdent,
      descripcion,
    });

    if (linea === "MANO_OBRA") {
      tieneServicio = true;
      manoObra += importe;
      if (descripcion) lineasServicio.push({ descripcion: descripcion.trim(), importe });
    } else if (linea === "REFACCION") {
      refacciones += importe;
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    esServicio: tieneServicio,
    manoObra: r2(manoObra),
    refacciones: r2(refacciones),
    concepto: nombrarOrden(lineasServicio),
    vins: [...vins],
  };
}

/**
 * Nombre legible de la orden: las dos líneas de servicio más caras que SÍ
 * describen el trabajo. Con la regla anterior (primera línea) las órdenes se
 * llamaban «mano de obra» — y en los CFDIs de Margom esa línea llega a valer
 * $0.01, mientras el trabajo real («instalacion de balatas delanteras») queda
 * escondido. Si todas son genéricas, se conserva la primera para no dejarla
 * sin nombre.
 */
function nombrarOrden(lineas: Array<{ descripcion: string; importe: number }>): string | null {
  if (lineas.length === 0) return null;
  const descriptivas = lineas
    .filter((l) => !DESCRIPCION_GENERICA_RE.test(l.descripcion))
    .sort((a, b) => b.importe - a.importe);
  if (descriptivas.length === 0) return lineas[0].descripcion.slice(0, 200);
  return descriptivas
    .slice(0, 2)
    .map((l) => l.descripcion)
    .join(" + ")
    .slice(0, 200);
}

export interface DerivarServicioArgs {
  companyId: string;
  invoiceId: string;
  tipo: string;
  fecha: Date;
  total: number;
  rawXml: string | null;
  clienteId?: string | null;
}

/** Deriva la venta de servicio de una factura INGRESO de taller. */
export async function derivarServicioDesdeCfdiSiAplica(
  db: Db,
  args: DerivarServicioArgs
): Promise<boolean> {
  if (!args.rawXml || args.tipo !== "INGRESO") return false;
  if (tipoComprobanteDesdeCfdi(args.rawXml) === "E") return false; // notas de crédito no son órdenes

  const datos = extraerServicioCfdi(args.rawXml);
  if (!datos.esServicio) return false;

  // Idempotente por invoiceId (unique).
  const ya = await db.servicioVenta.findUnique({ where: { invoiceId: args.invoiceId }, select: { id: true } });
  if (ya) return false;

  // Unidad: el primer VIN mencionado que exista en el inventario.
  let vehiculoId: string | null = null;
  for (const vin of datos.vins) {
    const unidad = await unidadVigentePorVin(db, args.companyId, vin, { id: true });
    if (unidad) {
      vehiculoId = unidad.id;
      break;
    }
  }

  const creada = await db.servicioVenta.create({
    data: {
      companyId: args.companyId,
      invoiceId: args.invoiceId,
      clienteId: args.clienteId ?? null,
      vehiculoId,
      fecha: args.fecha,
      total: args.total,
      manoObra: datos.manoObra,
      refacciones: datos.refacciones,
      concepto: datos.concepto?.slice(0, 200) ?? null,
    },
  });

  // Workflow (fase 5b): si hay una orden de servicio abierta que empata por
  // VIN/unidad (o por cliente), este CFDI la ampara — se liga sola y la orden
  // queda «facturada» sin captura. El estado no se toca: entregar sigue siendo
  // acción del asesor.
  const filtros: Prisma.OrdenServicioWhereInput[] = [];
  if (datos.vins.length) filtros.push({ vin: { in: datos.vins } });
  if (vehiculoId) filtros.push({ vehiculoId });
  if (args.clienteId) filtros.push({ clienteId: args.clienteId });
  if (filtros.length) {
    const desde = new Date(args.fecha);
    desde.setDate(desde.getDate() - 60);
    const orden = await db.ordenServicio.findFirst({
      where: {
        companyId: args.companyId,
        servicioVentaId: null,
        estado: { in: ["RECIBIDA", "EN_PROCESO", "LISTA"] },
        recibidaAt: { gte: desde },
        OR: filtros,
      },
      orderBy: { recibidaAt: "asc" },
      select: { id: true },
    });
    if (orden) {
      await db.ordenServicio.update({ where: { id: orden.id }, data: { servicioVentaId: creada.id } });
    }
  }
  return true;
}
