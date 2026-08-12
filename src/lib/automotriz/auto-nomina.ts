// ─────────────────────────────────────────────────────────────────────────────
// Costo de nómina por LÍNEA DE NEGOCIO, derivado de los CFDIs de nómina.
//
// Sin esto, el estado de resultados del taller reporta ingreso sin costo: la
// mano de obra la producen técnicos que cobran nómina, y esa nómina estaba
// fuera del reporte. El complemento de nómina trae por recibo:
//   • Puesto        → la FUNCIÓN (TECNICO, LAVADOR, ASESOR DE SERV…)
//   • Departamento  → en la práctica de una agencia con plazas, la SUCURSAL
//     (PUEBLA, TEHUACAN, OAXACA, CORPORATIVO…)
//
// La clasificación se guarda por recibo (no por empleado) para que un cambio
// de puesto no reescriba la historia: cada periodo queda con el costo de la
// línea en la que realmente trabajó esa persona.
//
// Mismo contrato que las demás derivaciones: idempotente, no postea al ledger.
// ─────────────────────────────────────────────────────────────────────────────

import type { LineaNegocio, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const attrDe = (xml: string, nombre: string): string | null => {
  const m = xml.match(new RegExp(`\\b${nombre}="([^"]*)"`, "i"));
  return m ? m[1] : null;
};

/**
 * Clasifica un puesto en la línea de negocio que lo paga. Reglas por palabra
 * clave sobre el texto del CFDI — el orden importa: «asesor de servicio» es
 * taller aunque diga «asesor», y «gerente de ventas» es ventas aunque diga
 * «gerente». Lo que no cae en ninguna es ADMIN (el default honesto: si no se
 * puede probar que produce, es gasto de estructura).
 */
export function clasificarPuesto(puesto: string | null | undefined): LineaNegocio {
  const p = (puesto ?? "").toUpperCase();
  if (!p.trim()) return "ADMIN";

  // Taller: producción de servicio (incluye lavado y hojalatería/pintura, que
  // facturan dentro de las órdenes) y quien recibe/entrega la unidad.
  // Sin \b de cierre: los puestos vienen con sufijos («TECNICO», «LAVADOR»,
  // «HOJALATERO», «ALMACENISTA»), así que se empata por PREFIJO de palabra.
  if (
    /\b(TECNIC|MECANIC|HOJALAT|PINTOR|PINTUR|LAVAD|SERVICIO|TALLER|GARANTIA|DIAGNOST|ELECTRIC|MAESTRO)/.test(p) ||
    /ASESOR\s+DE\s+SERV/.test(p)
  ) {
    return "TALLER";
  }
  // Refacciones: mostrador y almacén de partes.
  if (/\b(REFACCION|MOSTRADOR|ALMACEN)/.test(p)) return "REFACCIONES";
  // Ventas de unidades.
  if (/\b(VENDEDOR|VENTAS|FINANCIAMIENTO|SEMINUEVO)/.test(p) || /\bF\s*&\s*I\b/.test(p) || /ASESOR\s+COMERCIAL/.test(p)) {
    return "VENTAS";
  }
  return "ADMIN";
}

export interface DatosNominaCfdi {
  esNomina: boolean;
  puesto: string | null;
  sucursal: string | null;
  percepciones: number;
}

/**
 * Lee del CFDI de nómina el puesto, el departamento (sucursal) y el total de
 * percepciones. Las percepciones son el costo BRUTO del periodo — el total del
 * comprobante es el neto depositado, que subestima el costo real.
 */
export function extraerNominaCfdi(rawXml: string, subtotalFallback = 0): DatosNominaCfdi {
  const receptor = rawXml.match(/<(?:[\w-]+:)?Receptor\b([^>]*)>/i)?.[1] ?? "";
  const percepcionesNodo = rawXml.match(/<(?:[\w-]+:)?Percepciones\b([^>]*)>/i)?.[1] ?? "";
  const esNomina = /<(?:[\w-]+:)?Nomina\b/i.test(rawXml);

  const gravado = Number(attrDe(percepcionesNodo, "TotalGravado") ?? "0") || 0;
  const exento = Number(attrDe(percepcionesNodo, "TotalExento") ?? "0") || 0;
  const percepciones = gravado + exento > 0 ? gravado + exento : subtotalFallback;

  return {
    esNomina,
    puesto: attrDe(receptor, "Puesto"),
    sucursal: attrDe(receptor, "Departamento"),
    percepciones: Math.round(percepciones * 100) / 100,
  };
}

export interface DerivarNominaArgs {
  companyId: string;
  invoiceId: string;
  tipo: string;
  fecha: Date;
  rawXml: string | null;
  /** SubTotal del comprobante: respaldo cuando el complemento no trae totales. */
  subtotal?: number;
}

/** Deriva el costo de nómina de un recibo. Idempotente por invoiceId. */
export async function derivarNominaCostoSiAplica(db: Db, args: DerivarNominaArgs): Promise<boolean> {
  if (!args.rawXml || args.tipo !== "NOMINA") return false;

  const datos = extraerNominaCfdi(args.rawXml, args.subtotal ?? 0);
  if (!datos.esNomina || datos.percepciones <= 0) return false;

  const ya = await db.nominaCosto.findUnique({ where: { invoiceId: args.invoiceId }, select: { id: true } });
  if (ya) return false;

  await db.nominaCosto.create({
    data: {
      companyId: args.companyId,
      invoiceId: args.invoiceId,
      fecha: args.fecha,
      sucursal: datos.sucursal?.trim() || null,
      puesto: datos.puesto?.trim() || null,
      linea: clasificarPuesto(datos.puesto),
      percepciones: datos.percepciones,
    },
  });
  return true;
}
