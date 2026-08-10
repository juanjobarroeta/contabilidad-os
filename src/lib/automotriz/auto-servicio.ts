// ─────────────────────────────────────────────────────────────────────────────
// Derivación de VENTAS DE SERVICIO/TALLER desde CFDIs (fase 5, lado lectura).
// Una factura INGRESO es de taller si NO ampara unidades y trae al menos un
// concepto de servicio automotriz (clave 7818xx o texto de servicio). Se
// separa mano de obra vs refacciones por concepto y se liga cliente y — si el
// CFDI menciona el VIN — la unidad. Mismo contrato: idempotente, no postea.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { extraerDatosVehiculoCfdi, tipoComprobanteDesdeCfdi, vinsDesdeTexto } from "./vin";

type Db = PrismaClient | Prisma.TransactionClient;

const SERVICIO_TEXTO_RE =
  /\b(SERVICIO|MANTENIMIENTO|REPARACI[OÓ]N|MANO DE OBRA|LAVADO|AFINACI[OÓ]N|ALINEACI[OÓ]N|BALANCEO|DIAGN[OÓ]STICO|HOJALATER[IÍ]A|PINTURA)\b/i;

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
  let concepto: string | null = null;
  const vins = new Set<string>();
  let tieneServicio = false;

  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    const descripcion = attr(attrs, "Descripcion");
    const clave = attr(attrs, "ClaveProdServ") ?? "";
    const noIdent = attr(attrs, "NoIdentificacion");
    const importe = Number(attr(attrs, "Importe") ?? "0") || 0;

    for (const v of vinsDesdeTexto(descripcion)) vins.add(v);

    const esLineaServicio = clave.startsWith("7818") || (descripcion != null && SERVICIO_TEXTO_RE.test(descripcion));
    if (esLineaServicio) {
      tieneServicio = true;
      manoObra += importe;
      if (!concepto && descripcion) concepto = descripcion;
    } else if (noIdent) {
      refacciones += importe;
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { esServicio: tieneServicio, manoObra: r2(manoObra), refacciones: r2(refacciones), concepto, vins: [...vins] };
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
    const unidad = await db.vehiculo.findUnique({
      where: { companyId_vin: { companyId: args.companyId, vin } },
      select: { id: true },
    });
    if (unidad) {
      vehiculoId = unidad.id;
      break;
    }
  }

  await db.servicioVenta.create({
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
  return true;
}
