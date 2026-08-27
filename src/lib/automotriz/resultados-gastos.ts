// ─────────────────────────────────────────────────────────────────────────────
// Gastos de operación del estado de resultados: TODO lo demás que se factura.
//
// Después de las unidades (compras), las refacciones (kardex) y la nómina, el
// resto de los CFDIs de egreso es el gasto de la agencia: renta, luz, seguros,
// publicidad, honorarios, fletes… Se clasifican con el MISMO mapa que usa el
// cierre mensual (classifyInvoice → cuenta del catálogo COE del SAT), así que
// el tablero de operación y la contabilidad hablan el mismo idioma.
//
// Exclusiones deliberadas, para no contar dos veces lo que ya está arriba:
//   • CFDIs que amparan la COMPRA de una unidad (ya son costo del vehículo).
//   • CFDIs con movimientos de entrada al kardex (ya son costo de refacciones).
//   • CFDIs cuyos conceptos se atribuyeron a una unidad (fletes, acondicionamiento).
//   • Notas de crédito recibidas: restan del gasto, no suman.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";
import { classifyInvoice } from "@/lib/contabilidad/classify-egreso";

const r2 = (n: number) => Math.round(n * 100) / 100;

const CONCEPTO_RE = /<(?:[\w-]+:)?Concepto\b([^>]*?)(?:\/>|>)/gi;
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
};

export interface GastoLinea {
  cuenta: string;
  label: string;
  monto: number;
  facturas: number;
  /**
   * Qué claves del SAT alimentan esta cuenta, de mayor a menor.
   *
   * Un renglón de gasto agregado no se puede auditar: «Publicidad y marketing
   * $54,836,842» suena plausible y nadie lo cuestiona — que es exactamente lo
   * que pasó cuando el prefijo 8013 mandó $17M de RENTA a «Servicios
   * notariales». Con las claves a la vista, un mapeo demasiado ancho se ve de
   * inmediato: si dentro de publicidad aparece 80141615, que en los propios
   * CFDIs de MARGOM ampara «Unidad BMW X4 M40i», el prefijo está mal.
   */
  claves?: Array<{ clave: string; monto: number; facturas: number; ejemplo: string | null }>;
}

export interface GastosResultado {
  total: number;
  lineas: GastoLinea[];
  /** CFDIs de egreso sin XML: no se pueden clasificar, se reportan aparte. */
  sinClasificar: { facturas: number; monto: number };
  /** Anticipos a proveedores: NO son gasto. Se reportan para poder auditarlos. */
  anticipos: { facturas: number; monto: number };
  /** ISAN enterado: impuesto de la operación, va a la pestaña de impuestos. */
  isan: { facturas: number; monto: number };
}

/**
 * ISAN — Impuesto Sobre Automóviles Nuevos.
 *
 * El distribuidor lo cobra al comprador dentro del precio y lo entera al SAT:
 * es un impuesto de la OPERACIÓN, no un costo de operar la agencia. No pertenece
 * al margen (no es costo de la unidad) ni al gasto de estructura (no compra
 * nada) — pertenece junto al IVA y al ISR, que es donde el director lo busca.
 *
 * Dejarlo en gastos hundía la utilidad de operación ~$14.8M al año en Margom por
 * una salida de efectivo que nunca fue suya.
 *
 * Clave 93161700 del catálogo del SAT («Administración de impuestos») más el
 * texto, porque esa clave la usan también para otros pagos de derechos.
 */
const CLAVE_IMPUESTOS = "93161700";
const ISAN_TEXTO_RE = /\bI\.?\s?S\.?\s?A\.?\s?N\.?\b/i;

/**
 * Anticipo del bien o servicio (clave 84111506, guía de anticipos del Anexo 20).
 *
 * Un anticipo NO es un gasto: es dinero entregado a cuenta que la factura final
 * viene a sustituir, y el CFDI de aplicación lo descuenta. Contarlo como gasto
 * carga dos veces la misma compra.
 *
 * En Margom eran $72,165,217 en 406 facturas —el 47% de «Otros gastos»— casi
 * todo anticipos a Yutong por camiones eléctricos que todavía no llegan. Con
 * ellos dentro, la agencia reportaba $77M de pérdida de operación teniendo
 * utilidad. Del lado de los INGRESOS ya se excluían; del lado del gasto, no.
 */
const CLAVE_ANTICIPO = "84111506";

/** Conceptos de un CFDI para el clasificador (clave + importe por línea). */
function conceptosDe(rawXml: string): Array<{ claveProdServ: string; importe: number; descripcion: string }> {
  const out: Array<{ claveProdServ: string; importe: number; descripcion: string }> = [];
  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    out.push({
      claveProdServ: attr(attrs, "ClaveProdServ") ?? "",
      importe: Number(attr(attrs, "Importe") ?? "0") || 0,
      descripcion: attr(attrs, "Descripcion") ?? "",
    });
  }
  return out;
}

export async function gastosDeOperacion(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<GastosResultado> {
  const facturas = (
    await db.invoice.findMany({
      where: {
        companyId,
        tipo: "EGRESO",
        status: { not: "CANCELLED" },
        fecha: { gte: desde, lt: hasta },
        // Ya contados arriba: compra de unidad, costos atribuidos a una unidad y
        // entradas de refacciones.
        vehiculosComprados: { none: {} },
        vehiculoCostos: { none: {} },
        refaccionMovimientos: { none: {} },
      },
      select: { id: true, subtotal: true, tipoSat: true, rawXml: true },
    })
  ).map((f) => ({ ...f, subtotal: Number(f.subtotal) }));

  const porCuenta = new Map<string, GastoLinea>();
  const claves = new Map<string, Map<string, { monto: number; facturas: number; ejemplo: string | null }>>();
  let sinXml = 0;
  let montoSinXml = 0;
  let anticipos = 0;
  let montoAnticipos = 0;
  let isanFacturas = 0;
  let montoIsan = 0;

  for (const f of facturas) {
    // Nota de crédito recibida: resta del gasto (devolución/descuento).
    const signo = (f.tipoSat ?? "I") === "E" ? -1 : 1;
    if (!f.rawXml) {
      sinXml++;
      montoSinXml = r2(montoSinXml + signo * f.subtotal);
      continue;
    }
    const conceptos = conceptosDe(f.rawXml);

    // El anticipo se decide por el concepto DOMINANTE, igual que la
    // clasificación: una factura mixta con una línea chica de anticipo sigue
    // siendo gasto por lo que realmente ampara.
    const dominante = [...conceptos].sort((a, b) => b.importe - a.importe)[0];
    if (dominante?.claveProdServ === CLAVE_ANTICIPO) {
      anticipos++;
      montoAnticipos = r2(montoAnticipos + signo * f.subtotal);
      continue;
    }

    if (dominante?.claveProdServ === CLAVE_IMPUESTOS && ISAN_TEXTO_RE.test(dominante.descripcion)) {
      isanFacturas++;
      montoIsan = r2(montoIsan + signo * f.subtotal);
      continue;
    }

    const { cuenta, label } = classifyInvoice(conceptos);
    const acc = porCuenta.get(cuenta) ?? { cuenta, label, monto: 0, facturas: 0 };
    acc.monto = r2(acc.monto + signo * f.subtotal);
    acc.facturas++;
    porCuenta.set(cuenta, acc);

    // La clave DOMINANTE es la que decidió la clasificación, así que es la que
    // hay que poder auditar.
    if (dominante) {
      const porClave = claves.get(cuenta) ?? new Map<string, { monto: number; facturas: number; ejemplo: string | null }>();
      const k = porClave.get(dominante.claveProdServ) ?? { monto: 0, facturas: 0, ejemplo: null };
      k.monto = r2(k.monto + signo * f.subtotal);
      k.facturas++;
      if (k.ejemplo == null && dominante.descripcion) k.ejemplo = dominante.descripcion.slice(0, 70);
      porClave.set(dominante.claveProdServ, k);
      claves.set(cuenta, porClave);
    }
  }

  const lineas = [...porCuenta.values()]
    .sort((a, b) => b.monto - a.monto)
    .map((l) => ({
      ...l,
      claves: [...(claves.get(l.cuenta) ?? new Map()).entries()]
        .map(([clave, v]) => ({ clave, ...v }))
        .sort((a, b) => b.monto - a.monto)
        // 8 claves no alcanzan: en «Otros gastos» de MARGOM son 3,412 facturas
        // y las 8 mayores cubrían el 40% — $15.6M sin ver, justo en la cubeta
        // de descarte, que es donde hay que mirar.
        .slice(0, 25),
    }));
  return {
    // Los anticipos NO entran al total: no son gasto del periodo.
    total: r2(lineas.reduce((s, l) => s + l.monto, 0) + montoSinXml),
    lineas,
    sinClasificar: { facturas: sinXml, monto: montoSinXml },
    anticipos: { facturas: anticipos, monto: montoAnticipos },
    isan: { facturas: isanFacturas, monto: montoIsan },
  };
}
