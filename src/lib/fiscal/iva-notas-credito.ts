// ─────────────────────────────────────────────────────────────────────────────
// NOTAS DE CRÉDITO RECIBIDAS Y EL IVA ACREDITABLE (Art. 7 LIVA).
//
// Quien RECIBE un descuento, bonificación o devolución disminuye su IVA
// acreditable en el mes en que lo recibe, por el IVA de la nota. La nota (CFDI
// tipo E del proveedor) ES esa constancia: la reducción no depende de que haya
// un movimiento en el banco.
//
// El bug que esto corrige: en modo FLUJO el motor pasaba la nota por la misma
// regla que un gasto PUE —«se acredita lo pagado según la conciliación»—. Una
// nota casi nunca tiene movimiento (se aplica contra la factura, no se cobra),
// así que salía SIN_PAGO y restaba CERO. El acreditable quedaba inflado por el
// IVA de todas las notas del mes, y además se sumaba al aviso de «PUE sin pago».
// El papel de trabajo era peor: sumaba la nota como IVA acreditable POSITIVO.
//
// Dos cuidados para no restar dos veces:
//
//   · Padre PPD con saldo. Si la nota corrige una factura PPD que aún no se
//     pagó completa, el IVA de ese padre todavía no se acreditó: se acredita
//     con cada REP, y los REP ya vienen por el importe NETO de la nota. Aquí
//     sólo se resta la parte de la nota que excede el saldo del padre a la
//     fecha de la nota (lo que ya se había acreditado de más).
//   · Padre PUE en flujo. Si el proveedor cobra el padre neto de la nota,
//     el banco nunca ve el total y el padre quedaría «PARCIAL» para siempre.
//     `totalNetoDeNotas` le quita al total del padre lo que sus notas
//     corrigieron: pagado el neto, el padre acredita completo y la nota resta
//     su IVA — en cualquier orden, el mismo resultado.
//
// La relación se lee de Invoice.cfdiRelacionadoUuid (relaciones-backfill) y,
// para las notas del mes, directo del rawXml, que sí trae TODOS los padres.
// Nota sin padre identificable: se resta su propio IVA, que es lo que dice la
// ley y lo que haría el contador con la nota en la mano.
//
// La decisión es PURA (reduccionPorNotaRecibida, totalNetoDeNotas); las
// consultas están aparte. Las leen el motor (computeTaxPosition) y el papel
// de trabajo (/api/papeles/iva), para que den la misma cifra.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { normalizarUuid, variantesUuid } from "./uuid";
import { REP_VIGENTE } from "./rep-vigente";

/**
 * TipoRelacion con que una nota E corrige a su padre: 01 nota de crédito,
 * 03 devolución de mercancía, 07 aplicación de anticipo. 04 (sustitución) no
 * es una corrección de importe.
 */
export const RELACIONES_DE_NOTA = new Set(["01", "03", "07"]);

/** Holgura de centavos, la misma que `pagadaCompleta`. */
const TOL = 0.5;

export interface PadreDeNota {
  uuid: string;
  metodoPago: string | null;
  total: number;
  /** El contador excluyó el IVA del padre: no hay acreditamiento que disminuir. */
  ivaNoAcreditable: boolean;
  /** Pagado al padre por REP hasta la fecha de la nota (sólo importa en PPD). */
  pagadoAntesDeLaNota: number;
}

export type EstadoNota =
  | "SIN_IVA"
  | "SIN_PADRE"
  | "PADRE_NO_ACREDITABLE"
  | "CUBIERTA_POR_SALDO"
  | "PARCIAL"
  | "COMPLETA";

export interface ReduccionNota {
  /** IVA a RESTAR del acreditable del mes, en positivo. */
  reduccion: number;
  estado: EstadoNota;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Cuánto IVA acreditable disminuye una nota de crédito recibida. PURA.
 * `ivaNeto` = IVA trasladado − retenido de la nota (mismo neto que el gasto).
 */
export function reduccionPorNotaRecibida(
  nota: { total: number; ivaNeto: number },
  padres: PadreDeNota[],
): ReduccionNota {
  const iva = Math.max(0, nota.ivaNeto);
  if (iva <= 0.005) return { reduccion: 0, estado: "SIN_IVA" };
  if (padres.length === 0) return { reduccion: round2(iva), estado: "SIN_PADRE" };

  const acreditables = padres.filter((p) => !p.ivaNoAcreditable);
  if (acreditables.length === 0) return { reduccion: 0, estado: "PADRE_NO_ACREDITABLE" };

  const total = Math.abs(nota.total);
  if (total <= 0) return { reduccion: round2(iva), estado: "COMPLETA" };

  // Lo que aún se debe de los padres PPD: ese IVA no se ha acreditado y los
  // REP que falten ya vendrán netos de la nota.
  const saldoPpd = acreditables
    .filter((p) => p.metodoPago === "PPD")
    .reduce((s, p) => s + Math.max(0, p.total - p.pagadoAntesDeLaNota), 0);
  const excedente = Math.max(0, total - saldoPpd);
  if (excedente <= TOL) return { reduccion: 0, estado: "CUBIERTA_POR_SALDO" };
  const fraccion = Math.min(1, excedente / total);
  if (fraccion >= 1 - 1e-9) return { reduccion: round2(iva), estado: "COMPLETA" };
  return { reduccion: round2(iva * fraccion), estado: "PARCIAL" };
}

/**
 * El total contra el que se juzga «pagado completo» un PUE que tiene notas de
 * crédito: el total menos lo que las notas corrigieron. PURA.
 */
export function totalNetoDeNotas(total: number, totalNotas: number): number {
  return Math.max(0, Math.abs(total) - Math.max(0, totalNotas));
}

/**
 * Los UUID de los padres que una nota corrige, normalizados. Lee el rawXml
 * (trae todos los nodos CfdiRelacionados) y cae a las columnas escalares.
 * El regex es el mismo de `parseCfdiXml`; se repite aquí para no arrastrar
 * las dependencias de la e.firma al motor de impuestos.
 */
export function padresDeNota(nota: {
  rawXml?: string | null;
  cfdiRelacionadoUuid?: string | null;
  tipoRelacion?: string | null;
}): string[] {
  const out = new Set<string>();
  const xml = nota.rawXml ?? "";
  if (xml.includes("CfdiRelacionados")) {
    const relRe =
      /<(?:[a-zA-Z0-9]+:)?CfdiRelacionados\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?CfdiRelacionados>/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(xml)) !== null) {
      const tipo = /\bTipoRelacion="([^"]*)"/.exec(rm[1] ?? "")?.[1]?.trim();
      if (!tipo || !RELACIONES_DE_NOTA.has(tipo)) continue;
      for (const r of (rm[2] ?? "").matchAll(/<(?:[a-zA-Z0-9]+:)?CfdiRelacionado\b([^>]*?)\/?>/g)) {
        const u = /\bUUID="([^"]*)"/.exec(r[1] ?? "")?.[1]?.trim();
        if (u) out.add(normalizarUuid(u));
      }
    }
  }
  if (out.size === 0 && nota.cfdiRelacionadoUuid && RELACIONES_DE_NOTA.has(nota.tipoRelacion ?? "")) {
    out.add(normalizarUuid(nota.cfdiRelacionadoUuid));
  }
  return [...out];
}

type NotaConRelacion = {
  id: string;
  fecha: Date;
  total: number | { toString(): string };
  rawXml?: string | null;
  cfdiRelacionadoUuid?: string | null;
  tipoRelacion?: string | null;
};

/**
 * Los padres (EGRESO de la misma empresa) de cada nota recibida, con lo pagado
 * por REP antes de la nota. Un padre que no está descargado no aparece: la
 * nota se trata como SIN_PADRE (resta su propio IVA).
 */
export async function padresDeNotasRecibidas(
  companyId: string,
  notas: NotaConRelacion[],
): Promise<Map<string, PadreDeNota[]>> {
  const out = new Map<string, PadreDeNota[]>();
  const uuidsPorNota = new Map(notas.map((n) => [n.id, padresDeNota(n)]));
  const todos = [...new Set([...uuidsPorNota.values()].flat())];
  if (todos.length === 0) return out;

  const [padres, pagos] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", uuid: { in: variantesUuid(todos) } },
      select: { uuid: true, metodoPago: true, total: true, ivaNoAcreditable: true },
    }),
    prisma.pagoDoctoRelacionado.findMany({
      where: {
        parentUuid: { in: variantesUuid(todos) },
        pagoInvoice: { companyId, ...REP_VIGENTE },
      },
      select: { parentUuid: true, impPagado: true, fechaPago: true },
    }),
  ]);
  const padrePorUuid = new Map(padres.map((p) => [normalizarUuid(p.uuid ?? ""), p]));

  for (const n of notas) {
    const lista: PadreDeNota[] = [];
    for (const u of uuidsPorNota.get(n.id) ?? []) {
      const p = padrePorUuid.get(u);
      if (!p) continue;
      const pagadoAntes = pagos
        .filter((l) => normalizarUuid(l.parentUuid) === u && l.fechaPago != null && l.fechaPago <= n.fecha)
        .reduce((s, l) => s + Number(l.impPagado ?? 0), 0);
      lista.push({
        uuid: u,
        metodoPago: p.metodoPago,
        total: Number(p.total),
        ivaNoAcreditable: p.ivaNoAcreditable,
        pagadoAntesDeLaNota: pagadoAntes,
      });
    }
    out.set(n.id, lista);
  }
  return out;
}

/**
 * Suma de las notas recibidas (hasta `to`) que corrigen a cada PUE, por UUID
 * normalizado del padre. Junta las notas por columna (relaciones-backfill) y
 * las `notasDelMes` ya cargadas, leídas del rawXml; cada nota cuenta una vez.
 */
export async function notasRecibidasPorPadre(
  companyId: string,
  padreUuids: Array<string | null | undefined>,
  to: Date,
  notasDelMes: NotaConRelacion[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const buscados = new Set(padreUuids.filter((u): u is string => !!u).map(normalizarUuid));
  if (buscados.size === 0) return out;

  const vistas = new Set<string>();
  const sumar = (notaId: string, padres: string[], total: number) => {
    if (vistas.has(notaId)) return;
    const mios = padres.filter((u) => buscados.has(u));
    if (mios.length === 0) return;
    vistas.add(notaId);
    // Una nota que corrige a varios padres se reparte por partes iguales: el
    // CFDI no dice cuánto toca a cada uno, y para el umbral de «pagado
    // completo» basta con no inflar a ninguno.
    for (const u of mios) out.set(u, (out.get(u) ?? 0) + Math.abs(total) / mios.length);
  };

  for (const n of notasDelMes) sumar(n.id, padresDeNota(n), Number(n.total));

  const porColumna = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      tipoSat: "E",
      status: "STAMPED",
      fecha: { lt: to },
      tipoRelacion: { in: [...RELACIONES_DE_NOTA] },
      cfdiRelacionadoUuid: { in: variantesUuid(buscados) },
    },
    select: { id: true, total: true, cfdiRelacionadoUuid: true },
  });
  for (const n of porColumna) sumar(n.id, [normalizarUuid(n.cfdiRelacionadoUuid ?? "")], Number(n.total));
  return out;
}
