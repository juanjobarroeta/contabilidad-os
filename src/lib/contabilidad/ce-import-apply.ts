// ─────────────────────────────────────────────────────────────────────────────
// Aplicación (con DB) de la importación de Contabilidad Electrónica (Anexo 24).
//
// Toma los parsers PUROS de ce-import.ts y los persiste de forma conservadora e
// idempotente:
//
//   • importarCatalogo: upsert de ChartAccount por (companyId, cuentaSAT, subcuenta).
//     No duplica cuentas existentes; respeta la naturaleza del XML. El "código"
//     usado para empatar con la balanza y con la app es el NumCta (clave interna
//     de la empresa) — se guarda como subcuenta cuando tiene punto (102.01), o
//     como cuentaSAT de mayor cuando es un código sin subnivel.
//
//   • importarBalanza: reutiliza postApertura (apertura.ts) para crear el asiento
//     de saldos iniciales con fuente=APERTURA. postApertura YA es idempotente
//     (borra la apertura previa y la reemplaza) y NUNCA toca asientos CFDI/NOMINA/
//     BANCO/MANUAL. Aquí sólo traducimos la balanza a líneas {codigo, saldo}.
//
// No se hace aritmética contable aquí: la partida doble vive en apertura.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { postApertura, type AperturaError } from "./apertura";
import { naturalezaPorTipo, type Naturaleza } from "./coe-saldos";
import {
  parseCatalogoCuentas,
  parseBalanza,
  balanzaASaldosApertura,
  tipoPorCodAgrup,
  type CatalogoCuentaParsed,
} from "./ce-import";

/**
 * El "código" canónico de una cuenta del catálogo en la app es el NumCta. Lo
 * descomponemos en (cuentaSAT, subcuenta) igual que el catálogo starter: si trae
 * punto (p.ej. "102.01"), cuentaSAT es la parte mayor ("102") y subcuenta el
 * código completo; si no, es una cuenta de mayor sin subcuenta.
 */
function descomponerCodigo(numCta: string): { cuentaSAT: string; subcuenta: string | null } {
  const code = numCta.trim();
  if (code.includes(".")) {
    return { cuentaSAT: code.split(".")[0], subcuenta: code };
  }
  return { cuentaSAT: code, subcuenta: null };
}

export interface ImportarCatalogoResult {
  total: number;
  creadas: number;
  actualizadas: number;
  omitidas: number;
}

/**
 * Importa (upsert) el catálogo de cuentas del XML del SAT en ChartAccount.
 * Idempotente: empata por (companyId, cuentaSAT, subcuenta). Las cuentas ya
 * existentes se actualizan en nombre/nivel/naturaleza (sin duplicar). Devuelve
 * conteos. Función con DB.
 */
export async function importarCatalogo(
  companyId: string,
  xml: string,
): Promise<ImportarCatalogoResult> {
  const { cuentas } = parseCatalogoCuentas(xml);
  let creadas = 0;
  let actualizadas = 0;
  let omitidas = 0;

  for (const c of cuentas) {
    const ok = await upsertCuenta(companyId, c);
    if (ok === "creada") creadas++;
    else if (ok === "actualizada") actualizadas++;
    else omitidas++;
  }

  return { total: cuentas.length, creadas, actualizadas, omitidas };
}

async function upsertCuenta(
  companyId: string,
  c: CatalogoCuentaParsed,
): Promise<"creada" | "actualizada" | "omitida"> {
  const { cuentaSAT, subcuenta } = descomponerCodigo(c.numCta);
  if (!cuentaSAT) return "omitida";

  const tipo = tipoPorCodAgrup(c.codAgrup);
  const data = {
    nombre: c.desc || c.numCta,
    tipo,
    nivel: c.nivel,
    naturaleza: c.natur,
  };

  const existing = await prisma.chartAccount.findFirst({
    where: { companyId, cuentaSAT, subcuenta },
    select: { id: true },
  });

  if (existing) {
    await prisma.chartAccount.update({ where: { id: existing.id }, data: { ...data, isActive: true } });
    return "actualizada";
  }

  await prisma.chartAccount.create({
    data: { companyId, cuentaSAT, subcuenta, ...data },
  });
  return "creada";
}

export interface ImportarBalanzaResult {
  entries: number;
  totalCargos: number;
  totalAbonos: number;
  fecha: string;
  /** Cuentas de la balanza que no existían en el catálogo (se ignoraron). */
  cuentasSinCatalogo: string[];
}

/**
 * Importa la balanza de comprobación como saldos de apertura, reutilizando
 * postApertura (idempotente; reemplaza la apertura previa y no toca asientos
 * CFDI/NOMINA/BANCO/MANUAL).
 *
 * `usar`:
 *   • "final"   → SaldoFin de la balanza (cierre del periodo = apertura del
 *                 siguiente mes). Es lo esperado cuando se sube la ÚLTIMA balanza
 *                 presentada para arrancar el mes siguiente.
 *   • "inicial" → SaldoIni (apertura del propio periodo de la balanza).
 *
 * `fechaISO`: fecha del asiento de apertura. Por defecto el primer día del mes
 * siguiente al de la balanza (apertura = arranque del periodo siguiente al cierre).
 */
export async function importarBalanza(
  companyId: string,
  xml: string,
  opts: { usar?: "inicial" | "final"; fechaISO?: string } = {},
): Promise<ImportarBalanzaResult> {
  const usar = opts.usar ?? "final";
  const bal = parseBalanza(xml);

  // Catálogo de la empresa para resolver naturaleza por código y filtrar a
  // cuentas existentes (las agregadas duplicarían saldos; sólo posteamos las
  // que existen en ChartAccount).
  const accounts = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true },
    select: { cuentaSAT: true, subcuenta: true, tipo: true, naturaleza: true },
  });
  const porCodigo = new Map<string, { naturaleza: Naturaleza }>();
  for (const a of accounts) {
    const codigo = a.subcuenta ?? a.cuentaSAT;
    const nat = (a.naturaleza as Naturaleza | null) ?? naturalezaPorTipo(a.tipo);
    porCodigo.set(codigo, { naturaleza: nat });
  }

  // Sólo cuentas de DETALLE (hojas). La balanza del SAT trae el mayor Y sus
  // subcuentas — «601» junto a 601.01…601.84 — y el saldo del mayor YA es la
  // suma de sus hijas: postear ambos duplica el subárbol entero y la apertura
  // no cuadra. Caso real (AMA170817NK1, balanza 2026-06): 31 mayores con 1,388
  // hojas, cargos 1,204,754,136.18 vs abonos 1,163,763,593.32.
  // Una cuenta es hoja si ninguna otra de la MISMA balanza cuelga de ella.
  const codigosBalanza = new Set(bal.cuentas.map((c) => c.numCta));
  const esPadre = new Set<string>();
  for (const codigo of codigosBalanza) {
    const partes = codigo.split(".");
    for (let i = 1; i < partes.length; i++) esPadre.add(partes.slice(0, i).join("."));
  }
  const esDetalle = (numCta: string) => !esPadre.has(numCta);

  const cuentasSinCatalogo: string[] = [];
  for (const c of bal.cuentas) {
    const magnitud = usar === "inicial" ? c.saldoIni : c.saldoFin;
    if (Math.abs(magnitud) < 0.005) continue;
    if (!esDetalle(c.numCta)) continue; // un mayor sin catálogo no es un faltante
    if (!porCodigo.has(c.numCta)) cuentasSinCatalogo.push(c.numCta);
  }

  const lineas = balanzaASaldosApertura({
    cuentas: bal.cuentas,
    usar,
    naturalezaPorCodigo: (numCta) => porCodigo.get(numCta)?.naturaleza,
    incluir: (numCta) => esDetalle(numCta) && porCodigo.has(numCta),
  });

  // Si la apertura no cuadra, el desglose es lo primero que se pregunta.
  // postApertura lanza sin escribir nada, así que este log es la única pista.
  if (cuentasSinCatalogo.length > 0) {
    console.warn(
      `[ce-apertura] ${companyId}: ${cuentasSinCatalogo.length} cuentas de detalle con saldo ` +
        `fuera del catálogo (el catálogo puede ser más viejo que la balanza): ` +
        cuentasSinCatalogo.slice(0, 15).join(", "),
    );
  }

  const fechaISO = opts.fechaISO ?? fechaAperturaPorDefecto(bal.anio, bal.mes);

  const res = await postApertura(companyId, fechaISO, lineas);
  return { ...res, cuentasSinCatalogo };
}

/**
 * Fecha de apertura por defecto: primer día del mes SIGUIENTE al de la balanza
 * (el SaldoFin de un mes es el SaldoIni del siguiente). Si no hay año/mes en el
 * XML, usa el primer día del año actual.
 */
function fechaAperturaPorDefecto(anio: number | null, mes: number | null): string {
  if (anio && mes) {
    const d = new Date(Date.UTC(anio, mes, 1)); // mes 0-indexed → mes (1-12) = mes siguiente
    return d.toISOString().slice(0, 10);
  }
  const now = new Date();
  return `${now.getFullYear()}-01-01`;
}

export type { AperturaError };
