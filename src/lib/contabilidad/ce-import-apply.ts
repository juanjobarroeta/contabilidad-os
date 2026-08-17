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
  naturalezaPorAritmetica,
  padresDeBalanza,
  tipoPorCodAgrup,
  convencionQueCuadra,
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
  const desc = c.desc.trim();

  const existing = await prisma.chartAccount.findFirst({
    where: { companyId, cuentaSAT, subcuenta },
    select: { id: true, nombre: true },
  });

  if (existing) {
    // Un catálogo SIN `Desc` no debe borrar un nombre real.
    //
    // Antes se escribía `nombre: c.desc || c.numCta` en el update, así que un
    // catálogo que trajera la cuenta sin descripción machacaba el nombre bueno
    // con el propio código. Queda una fila que PARECE nombrada —`nombre` no es
    // null— pero cuyo nombre es el número, y toda conciliación por familia le
    // manda su dinero al bucket «sin explicar». Medido en MARGOM: 16 cuentas
    // así, una de ellas (1301-0028-0000) con $6.98M.
    const nombre = desc || existing.nombre;
    await prisma.chartAccount.update({
      where: { id: existing.id },
      // codAgrup sólo cuando el CT lo trae: un catálogo sin él no borra la llave.
      data: { nombre, tipo, nivel: c.nivel, naturaleza: c.natur, isActive: true, codAgrup: c.codAgrup || undefined },
    });
    return "actualizada";
  }

  // Al CREAR no hay alternativa: `nombre` es obligatorio en el esquema. El
  // código queda de marcador hasta que un catálogo traiga la descripción.
  const data = { nombre: desc || c.numCta, tipo, nivel: c.nivel, naturaleza: c.natur, codAgrup: c.codAgrup || null };

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
  //
  // La jerarquía se decide en padresDeBalanza (ce-import.ts), comparando por
  // grupos e ignorando el relleno de ceros. La regla anterior partía por punto
  // y sobre esa misma balanza —544 cuentas, TODAS con guion— encontraba 0
  // padres: 103 mayores entraban a la apertura junto con sus propias hijas.
  const esPadre = padresDeBalanza(bal.cuentas.map((c) => c.numCta));
  const esDetalle = (numCta: string) => !esPadre.has(numCta);

  const cuentasSinCatalogo: string[] = [];
  for (const c of bal.cuentas) {
    const magnitud = usar === "inicial" ? c.saldoIni : c.saldoFin;
    if (Math.abs(magnitud) < 0.005) continue;
    if (!esDetalle(c.numCta)) continue; // un mayor sin catálogo no es un faltante
    if (!porCodigo.has(c.numCta)) cuentasSinCatalogo.push(c.numCta);
  }

  // Cuentas de detalle con saldo que el catálogo no conoce: se dan de alta.
  // Resolver la naturaleza no basta — postApertura LANZA si el código no existe
  // en ChartAccount (apertura.ts), así que sin esto la apertura entera se cae
  // por 119 cuentas de MARGOM.
  //
  // La naturaleza sale del primer dígito del código de la empresa, vía
  // tipoPorCodAgrup + naturalezaPorTipo. Auditado contra las cuentas de la
  // balanza donde el SAT ya la dijo: acierta 393 y falla 24 (94.2%), contra
  // 240/58 (80.5%) de deducirla de la aritmética del renglón. La aritmética se
  // usa sólo para CONTRASTAR: si discrepa, la cuenta queda marcada.
  const enDisputa: string[] = [];
  for (const numCta of cuentasSinCatalogo) {
    const fila = bal.cuentas.find((c) => c.numCta === numCta);
    const tipo = tipoPorCodAgrup(numCta);
    const naturaleza = naturalezaPorTipo(tipo);
    const contraste = fila ? naturalezaPorAritmetica(fila) : null;
    if (contraste && contraste !== naturaleza) enDisputa.push(numCta);

    const { cuentaSAT, subcuenta } = descomponerCodigo(numCta);
    if (!cuentaSAT) continue;
    const ya = await prisma.chartAccount.findFirst({
      where: { companyId, cuentaSAT, subcuenta },
      select: { id: true },
    });
    if (ya) continue;
    await prisma.chartAccount.create({
      data: {
        companyId,
        cuentaSAT,
        subcuenta,
        nombre: numCta, // el nombre real llega cuando la empresa remande el catálogo
        tipo,
        nivel: numCta.split(/[.\-/]/).length,
        naturaleza,
      },
    });
    porCodigo.set(numCta, { naturaleza });
  }
  if (enDisputa.length > 0) {
    console.warn(
      `[ce-apertura] ${companyId}: ${enDisputa.length} cuentas donde el primer dígito y ` +
        `la aritmética de la balanza no coinciden (se usó el primer dígito): ` +
        enDisputa.slice(0, 15).join(", "),
    );
  }

  const seleccion = {
    cuentas: bal.cuentas,
    usar,
    naturalezaPorCodigo: (numCta: string) => porCodigo.get(numCta)?.naturaleza,
    incluir: (numCta: string) => esDetalle(numCta) && porCodigo.has(numCta),
  };

  // Cómo leer el importe NO es una preferencia nuestra: es una propiedad del
  // archivo. Hay balanzas que traen magnitud (cada cuenta va de su lado) y
  // balanzas que ya traen el lado en el signo. Elegir mal descuadra por el
  // DOBLE de todo lo que corre contra su naturaleza — en MARGOM, exactamente
  // los $48,318,111.11 que reportaba postApertura.
  //
  // No se configura por empresa ni se reconoce al sistema que la emitió: se
  // prueban las dos y se toma la que CUADRA. Un balance cuadra o no cuadra, y
  // eso vale igual para cualquier distribuidor.
  const conv = convencionQueCuadra(seleccion);
  if (conv.elegida === null) {
    console.warn(
      `[ce-apertura] ${companyId}: ninguna convención cuadra la balanza ` +
        `(natural: ${conv.natural.diferencia}, signo: ${conv.signo.diferencia}). ` +
        `El descuadre no está en la lectura del signo.`,
    );
  } else if (conv.elegida === "signo") {
    console.log(
      `[ce-apertura] ${companyId}: la balanza trae el lado en el SIGNO ` +
        `(leída como magnitud descuadraba por ${conv.natural.diferencia}).`,
    );
  }

  const lineas = balanzaASaldosApertura({
    ...seleccion,
    // Sin veredicto se conserva el comportamiento histórico y postApertura
    // lanza con el desglose, que es lo correcto: no inventamos un cuadre.
    convencion: conv.elegida ?? "natural",
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
