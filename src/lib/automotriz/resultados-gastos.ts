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
}

export interface GastosResultado {
  total: number;
  lineas: GastoLinea[];
  /** CFDIs de egreso sin XML: no se pueden clasificar, se reportan aparte. */
  sinClasificar: { facturas: number; monto: number };
  /** Anticipos a proveedores: NO son gasto. Se reportan para poder auditarlos. */
  anticipos: { facturas: number; monto: number };
}

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
function conceptosDe(rawXml: string): Array<{ claveProdServ: string; importe: number }> {
  const out: Array<{ claveProdServ: string; importe: number }> = [];
  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    out.push({
      claveProdServ: attr(attrs, "ClaveProdServ") ?? "",
      importe: Number(attr(attrs, "Importe") ?? "0") || 0,
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
  const facturas = await db.invoice.findMany({
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
  });

  const porCuenta = new Map<string, GastoLinea>();
  let sinXml = 0;
  let montoSinXml = 0;
  let anticipos = 0;
  let montoAnticipos = 0;

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

    const { cuenta, label } = classifyInvoice(conceptos);
    const acc = porCuenta.get(cuenta) ?? { cuenta, label, monto: 0, facturas: 0 };
    acc.monto = r2(acc.monto + signo * f.subtotal);
    acc.facturas++;
    porCuenta.set(cuenta, acc);
  }

  const lineas = [...porCuenta.values()].sort((a, b) => b.monto - a.monto);
  return {
    // Los anticipos NO entran al total: no son gasto del periodo.
    total: r2(lineas.reduce((s, l) => s + l.monto, 0) + montoSinXml),
    lineas,
    sinClasificar: { facturas: sinXml, monto: montoSinXml },
    anticipos: { facturas: anticipos, monto: montoAnticipos },
  };
}
