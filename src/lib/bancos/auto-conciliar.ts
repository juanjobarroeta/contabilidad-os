import { prisma } from "@/lib/prisma";
import { conciliarPorRepEmpresa } from "./rep-aplicar";
import { cercaPeroNoExactoEnLote, mismoImporte, tarjetaContradice, tarjetaDeLiquidacion } from "./terminal";
import { detectarTraspasosEmpresa } from "./traspasos-aplicar";
import {
  campoMontoPorTipo,
  esTipoImpuestoConciliable,
  mismaLineaCaptura,
  TIPOS_IMPUESTO_CONCILIABLES,
} from "@/lib/conciliacion-impuestos";

// ─────────────────────────────────────────────────────────────────────────────
// Auto-conciliación bancaria de alta confianza (motor reutilizable)
//
// Extrae la lógica de auto-aplicación del POST /api/bancos/[id]/match para que
// pueda usarse tanto desde la ruta (un click del usuario) como desde el cron
// diario (toda la cartera). NO cambia el umbral ni el scoring.
//
// Idempotente: toca transacciones UNMATCHED y una sola clase de IGNORED — los
// pagos de impuestos auto-ignorados por el categorizador (nota TAX_PAYMENT)
// cuya línea de captura identifica a su declaración. Nunca des-concilia, y un
// IGNORED puesto por el usuario no se toca. Best-effort.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 14;
/** Ventana para candidatos cuyo RFC empata con el del movimiento: la identidad
 *  sustituye a la cercanía de fechas (ver el bloque en autoConciliarCuenta). */
const IDENTITY_WINDOW_DAYS = 60;
const TOLERANCE = 0.01; // 1%

// Umbral de auto-aplicación: muy alta confianza Y sin ambigüedad.
// - Score >= 130
// - Ningún otro candidato a menos de 20 puntos del ganador (evita conciliar mal
//   cuando varias facturas tienen el mismo monto).
//
// OJO CON ESTE NÚMERO: monto exacto (100) + mismo día (30) = 130 clava el umbral
// justo. Es decir, sin señal de contraparte el sistema auto-concilia por MONTO Y
// FECHA, y lo único que lo protege de emparejar la factura equivocada es la
// regla de ambigüedad. Por eso la identidad de la contraparte no se suma como
// un puntito más: es lo que convierte "adivinar por monto" en "identificar por
// parte y confirmar por monto".
/** Conciliaciones resueltas por complemento de pago (evidencia, no inferencia). */
export interface RepStats { conciliados: number; facturas: number; ambiguos: number }

export const AUTO_MATCH_MIN_SCORE = 130;
export const AUTO_MATCH_AMBIGUITY_GAP = 20;

/** Señales de identidad, de más fuerte a más débil. */
export const PUNTOS_RFC_EXACTO = 120;
/** El folio de la factura escrito en el concepto («REF FACT 7781», «PAGO
 *  A-1033»): quien paga nombró al documento — casi determinista. Entre el RFC
 *  y el monto exacto a propósito. */
export const PUNTOS_FOLIO = 90;
export const PUNTOS_CLABE_CONOCIDA = 80;
export const PUNTOS_RFC_EN_TEXTO = 25;
export const PUNTOS_NOMBRE = 40;
/**
 * Bono por IMPORTE ÚNICO CON CENTAVOS. Un importe exacto al centavo que además
 * es el ÚNICO exacto entre los candidatos se identifica solo: $19,439.75 no se
 * repite por casualidad. Sin este bono ese caso puntúa 100 —monto exacto y
 * nada más— y muere contra el umbral de 130 aunque el segundo candidato esté a
 * 50 puntos de distancia; visto en producción, con la factura enfrente.
 *
 * Exige CENTAVOS a propósito. Los importes redondos coinciden todo el tiempo:
 * en el mismo hospital hay 38 facturas de $3,770.00 —la tarifa de un estudio—
 * y ahí la unicidad no existe ni debe inventarse.
 */
export const PUNTOS_IMPORTE_UNICO = 40;

/**
 * Castigo por TARJETA CONTRARIA. Un lote de crédito no liquida una factura que
 * declara débito, ni al revés — son dos mitades del mismo hecho y no pueden
 * contradecirse.
 *
 * Se CASTIGA en vez de excluir a propósito: la forma de pago la captura una
 * persona y puede estar mal. Restar 120 hunde al candidato por debajo del
 * umbral —ni siquiera un importe exacto (100) lo salva— así que nunca se
 * aplica solo, pero sigue visible al final de la lista para quien sepa que la
 * captura fue errónea. Esconderlo sería decidir por el contador con un dato
 * que no controlamos.
 */
export const CASTIGO_TARJETA_CONTRARIA = 120;

/**
 * Castigo por «cerca pero no exacto» dentro de un lote de terminal. Un lote es
 * la SUMA de los cargos del día: que una factura sola se le parezca al 0.3 % no
 * dice nada. Se hunde para que no encabece la lista, pero sigue disponible para
 * armar el lote a mano —que es como de verdad se resuelve— y el importe EXACTO
 * no se toca, porque un lote de un solo cargo existe.
 */
export const CASTIGO_CERCA_EN_LOTE = 90;

/**
 * ¿Cuánto bono merece el importe? PURA.
 *
 * `totales` son los totales de TODOS los candidatos. Devuelve el bono sólo si
 * el importe trae centavos y exactamente un candidato lo empata al centavo.
 */
export function bonoImporteUnico(
  absAmount: number,
  totales: number[],
  opts: { enLoteTerminal?: boolean } = {},
): number {
  const enLote = opts.enLoteTerminal ?? false;
  // «Redondo» no significa lo mismo en una terminal. $21,000.00 transferidos
  // son una cantidad que alguien eligió; $21,000.00 cobrados con tarjeta son
  // el precio de un servicio. Por eso el filtro de importe elegido sólo aplica
  // fuera del lote.
  if (!enLote && esImporteElegido(absAmount)) return 0;
  const exactos = totales.filter((t) => mismoImporte(t, absAmount, enLote)).length;
  return exactos === 1 ? PUNTOS_IMPORTE_UNICO : 0;
}

/**
 * ¿El importe parece ELEGIDO por una persona? PURA.
 *
 * Un múltiplo exacto de mil —$10,000, $40,000, $164,000— es una cantidad que
 * alguien decidió: un abono a cuenta, un traspaso, un anticipo. Coinciden solos
 * y no identifican nada.
 *
 * Lo que NO es elegido es cualquier otro importe, tenga centavos o no. La regla
 * anterior exigía centavos y era demasiado tosca: dejaba fuera $39,730.00, que
 * de redondo no tiene nada —es un total con IVA que cayó así— y que era el
 * único candidato exacto entre seis. Se quedaba en 110 contra un umbral de 130,
 * con el segundo a 40 puntos de distancia, y había que aplicarlo a mano.
 *
 * La unicidad sigue siendo el otro candado: entre 38 facturas de $3,770.00 no
 * hay unicidad que premiar, aunque $3,770 no sea múltiplo de mil.
 */
export function esImporteElegido(absAmount: number): boolean {
  return Math.round(absAmount * 100) % 100_000 === 0;
}

/**
 * Tokens tipo folio en el concepto de un movimiento. Conservador para no
 * casar con referencias bancarias o fechas: sólo (a) el número que SIGUE a una
 * palabra clave de factura (FACT/FACTURA/FOLIO/FOL/REF/PAGO/F) o (b) un token
 * serie-folio explícito (letras+separador+dígitos, p. ej. «A-1033»). Devuelve
 * los candidatos normalizados SIN serie y CON serie (a1033) en minúsculas.
 */
export function foliosEnConcepto(descripcion: string): Set<string> {
  const out = new Set<string>();
  const d = (descripcion ?? "").toUpperCase();
  for (const m of d.matchAll(/\b(?:FACT(?:URA)?|FOLIO|FOL|REF|PAGO|F)[.:\s#-]*([A-Z]{0,3}[-\s]?\d{2,8})\b/g)) {
    const token = m[1].replace(/[-\s]/g, "");
    out.add(token.toLowerCase());
    const soloDigitos = token.replace(/^[A-Z]+/, "");
    if (soloDigitos) out.add(soloDigitos.toLowerCase());
  }
  for (const m of d.matchAll(/\b([A-Z]{1,3})[-]?(\d{3,8})\b/g)) {
    out.add((m[1] + m[2]).toLowerCase());
  }
  return out;
}

/** ¿El folio (o serie+folio) de la factura aparece nombrado en el concepto? */
export function folioNombrado(
  inv: { serie?: string | null; folio?: string | null },
  folios: Set<string>,
): boolean {
  if (!inv.folio || folios.size === 0) return false;
  const folio = String(inv.folio).trim().toLowerCase();
  if (!folio) return false;
  if (folios.has(folio)) return true;
  const serie = (inv.serie ?? "").trim().toLowerCase();
  return serie !== "" && folios.has(serie + folio);
}

// normalizarNombre / mismoNombre / tokenIdentificante viven en nombres.ts
// (módulo puro, sin prisma) porque también los usa código que llega al bundle
// del navegador. Se re-exportan aquí para no romper a los importadores; el
// import además los liga localmente (scoreCandidate usa mismoNombre).
import { mismoNombre } from "./nombres";
export { normalizarNombre, mismoNombre, tokenIdentificante } from "./nombres";

export interface SenalesTx {
  fecha: Date;
  descripcion: string;
  /** Extraídos de la descripción por spei-descripcion.ts. */
  contraparteRfc?: string | null;
  contraparteNombre?: string | null;
  contraparteClabe?: string | null;
}

// Calcula el score de una factura candidata contra una transacción bancaria.
// Función pura: misma fórmula que el POST /api/bancos/[id]/match.
export function scoreCandidate(
  inv: {
    total: number;
    fecha: Date;
    customerRfc: string | null;
    customerNombre?: string | null;
    serie?: string | null;
    folio?: string | null;
    /** CLABEs ya vistas para este cliente/proveedor en movimientos conciliados. */
    clabesConocidas?: readonly string[];
  },
  tx: SenalesTx,
  absAmount: number,
): number {
  let score = 0;
  const diff = Math.abs(Math.abs(inv.total) - absAmount);
  // Monto
  if (diff < 0.01) score += 100; // exacto
  else if (diff / absAmount < 0.005) score += 70; // <0.5%
  else if (diff / absAmount < TOLERANCE) score += 40; // <1%
  // Proximidad de fecha
  const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
  if (daysDiff <= 1) score += 30;
  else if (daysDiff <= 3) score += 20;
  else if (daysDiff <= 7) score += 10;

  const rfc = (inv.customerRfc ?? "").toUpperCase();

  // IDENTIDAD DE LA CONTRAPARTE ─────────────────────────────────────────────
  // El RFC extraído es igualdad de campo, no una búsqueda de subcadena en texto
  // libre: cuando empata, es la MISMA persona y el monto sólo confirma. Vale
  // más que el monto exacto a propósito — así una factura del cliente correcto
  // con monto aproximado le gana a una de otro cliente con monto clavado.
  const rfcTx = (tx.contraparteRfc ?? "").toUpperCase();
  if (rfc && rfcTx && rfc === rfcTx) {
    score += PUNTOS_RFC_EXACTO;
  } else if (rfc && tx.descripcion.toUpperCase().includes(rfc)) {
    // Respaldo histórico: el RFC suelto en la descripción, sin etiqueta.
    score += PUNTOS_RFC_EN_TEXTO;
  }

  // FOLIO nombrado en el concepto: quien paga citó al documento.
  if (folioNombrado(inv, foliosEnConcepto(tx.descripcion))) {
    score += PUNTOS_FOLIO;
  }

  // La CLABE identifica la cuenta, no a la persona; sube fuerte pero por debajo
  // del RFC, y sólo si YA se le vio a esta contraparte antes.
  if (tx.contraparteClabe && inv.clabesConocidas?.includes(tx.contraparteClabe)) {
    score += PUNTOS_CLABE_CONOCIDA;
  }

  // El nombre es la señal más floja: los bancos lo truncan y lo escriben a su
  // manera. Suma, pero no alcanza sola para cruzar el umbral.
  if (mismoNombre(tx.contraparteNombre, inv.customerNombre)) {
    score += PUNTOS_NOMBRE;
  }

  return score;
}

// Decide si el mejor candidato es auto-aplicable: alta confianza y sin ambigüedad.
export function isAutoApplicable(bestScore: number, secondBestScore: number | null): boolean {
  const unambiguous = secondBestScore == null || bestScore - secondBestScore >= AUTO_MATCH_AMBIGUITY_GAP;
  return bestScore >= AUTO_MATCH_MIN_SCORE && unambiguous;
}

/**
 * RFCs a los que esta CLABE ya se les vio, en movimientos YA CONCILIADOS.
 *
 * Es la memoria del sistema: la primera vez que se paga a un proveedor no hay
 * nada que recordar, pero de la segunda en adelante su CLABE lo identifica sin
 * ambigüedad. Sólo cuentan los conciliados — un movimiento sin conciliar no es
 * evidencia de nada, y usarlo propagaría un error de conciliación al siguiente
 * mes convertido en "conocimiento".
 */
export async function clabesConocidasPorRfc(companyId: string, clabe: string): Promise<Set<string>> {
  const previos = await prisma.bankTransaction.findMany({
    where: { companyId, contraparteClabe: clabe, status: "MATCHED", invoiceId: { not: null } },
    select: {
      invoice: { select: { contraparteRfc: true, customer: { select: { rfc: true } } } },
    },
    take: 50,
  });
  const rfcs = new Set<string>();
  for (const p of previos) {
    // Misma identidad efectiva que el scoring: Customer, o la contraparte del CFDI.
    const rfc = p.invoice?.customer?.rfc ?? p.invoice?.contraparteRfc;
    if (rfc) rfcs.add(rfc);
  }

  // El DIRECTORIO de cuentas: lo que el CEP nos enseñó de esa CLABE, firmado
  // por Banxico. Vale sin necesidad de historial — la primera vez que se le
  // paga a un proveedor no hay conciliaciones previas que escanear, pero si el
  // CEP ya dijo de quién es la cuenta, se sabe desde el primer movimiento.
  const directorio = await prisma.cuentaContraparte.findUnique({
    where: { companyId_clabe: { companyId, clabe: clabe.replace(/\D/g, "") } },
    select: { rfc: true },
  });
  if (directorio?.rfc) rfcs.add(directorio.rfc);

  return rfcs;
}

/**
 * Concilia un egreso contra su declaración por LÍNEA DE CAPTURA. Determinista:
 * el SAT emite la línea para UNA declaración; si el banco escribió la misma en
 * el movimiento, ese cargo pagó exactamente esa declaración — no hay score que
 * calcular ni umbral que cruzar.
 *
 * Aplica la MISMA transición que el PATCH manual (match-impuesto): movimiento
 * → MATCHED + taxDeclarationId; declaración → PAID con el monto realmente
 * cargado y fecha de pago del movimiento si estaba vacía. Si dos declaraciones
 * comparten la línea (corrupción de datos: no debería existir), NO se adivina.
 */
export type ResultadoImpuestoLC =
  | "conciliado"
  | "no_aplica" // sin línea de captura o es un depósito
  | "sin_declaracion" // ninguna declaración del sistema trae esa línea
  | "ambiguo"; // más de una la trae (corrupción): no se adivina

async function conciliarImpuestoPorLineaCaptura(tx: {
  id: string;
  companyId: string;
  monto: number;
  fecha: Date;
  lineaCaptura: string | null;
}): Promise<ResultadoImpuestoLC> {
  if (!tx.lineaCaptura || tx.monto >= 0) return "no_aplica";

  const decls = await prisma.taxDeclaration.findMany({
    where: {
      companyId: tx.companyId,
      tipo: { in: [...TIPOS_IMPUESTO_CONCILIABLES] },
      status: { not: "PAID" },
      lineaCaptura: { not: null },
      // v1: una declaración ↔ un movimiento (mismo guard que el PATCH).
      bankTransactions: { none: { status: "MATCHED" } },
    },
    select: { id: true, tipo: true, lineaCaptura: true, fechaPresentacion: true },
  });

  // La comparación normalizada vive en mismaLineaCaptura (espacios/guiones/caja).
  const candidatas = decls.filter(
    (d) => esTipoImpuestoConciliable(d.tipo) && mismaLineaCaptura(d.lineaCaptura, tx.lineaCaptura)
  );
  if (candidatas.length === 0) return "sin_declaracion";
  if (candidatas.length > 1) return "ambiguo";

  const decl = candidatas[0];
  if (!esTipoImpuestoConciliable(decl.tipo)) return "sin_declaracion"; // narrowing para TS
  const montoPagado = Math.round(Math.abs(tx.monto) * 100) / 100;
  await prisma.$transaction([
    prisma.bankTransaction.update({
      where: { id: tx.id },
      data: { status: "MATCHED", invoiceId: null, taxDeclarationId: decl.id },
    }),
    prisma.taxDeclaration.update({
      where: { id: decl.id },
      data: {
        status: "PAID",
        [campoMontoPorTipo(decl.tipo)]: montoPagado,
        ...(decl.fechaPresentacion == null ? { fechaPresentacion: tx.fecha } : {}),
      },
    }),
  ]);
  return "conciliado";
}

// Auto-concilia una cuenta bancaria: recorre sus transacciones UNMATCHED y
// aplica únicamente las coincidencias de alta confianza y sin ambigüedad.
// Devuelve cuántas concilió. Best-effort por transacción.
export interface ImpuestosLcStats {
  /** Movimientos con línea de captura que se intentaron. */
  candidatos: number;
  conciliados: number;
  /** El movimiento trae la línea pero NINGUNA declaración del sistema la trae:
   *  la contraparte del empate no existe (acuse sin parsear, periodo previo al
   *  alta, o declaración llevada fuera de la app). Este contador es el que
   *  distingue "el motor falla" de "no hay contra qué empatar". */
  sinDeclaracion: number;
  ambiguos: number;
}

export async function autoConciliarCuenta(
  accountId: string,
): Promise<{ matched: number; total: number; impuestosLc: ImpuestosLcStats }> {
  const vacio: ImpuestosLcStats = { candidatos: 0, conciliados: 0, sinDeclaracion: 0, ambiguos: 0 };
  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account) return { matched: 0, total: 0, impuestosLc: vacio };
  const impuestosLc = vacio;

  const companyId = account.companyId;
  const unmatched = (await prisma.bankTransaction.findMany({
    where: { bankAccountId: accountId, status: "UNMATCHED" },
  })).map((t) => ({ ...t, monto: Number(t.monto) }));

  let matched = 0;

  // PAGOS DE IMPUESTOS AUTO-IGNORADOS. El import los manda a IGNORED con nota
  // TAX_PAYMENT *antes* de que la conciliación corra, así que el camino por
  // línea de captura nunca los veía — por eso la primera corrida global dio
  // cero. Pasarlos a MATCHED + declaración PAID es estrictamente mejor que
  // IGNORED: siguen fuera de la bandeja, pero ahora con la evidencia de QUÉ
  // declaración pagaron. Sólo la nota exacta del categorizador — un movimiento
  // que el USUARIO ignoró a mano no se toca.
  const impuestosIgnorados = (await prisma.bankTransaction.findMany({
    where: {
      bankAccountId: accountId,
      status: "IGNORED",
      notes: "TAX_PAYMENT",
      lineaCaptura: { not: null },
      taxDeclarationId: null,
    },
  })).map((t) => ({ ...t, monto: Number(t.monto) }));
  for (const tx of impuestosIgnorados) {
    try {
      const r = await conciliarImpuestoPorLineaCaptura(tx);
      if (r !== "no_aplica") impuestosLc.candidatos++;
      if (r === "conciliado") {
        impuestosLc.conciliados++;
        matched++;
      } else if (r === "sin_declaracion") impuestosLc.sinDeclaracion++;
      else if (r === "ambiguo") impuestosLc.ambiguos++;
    } catch {
      // best-effort
    }
  }

  for (const tx of unmatched) {
    // IMPUESTOS PRIMERO, por línea de captura: es identidad, no inferencia. Si
    // aplica, este movimiento ya quedó conciliado y no compite con facturas.
    try {
      const r = await conciliarImpuestoPorLineaCaptura(tx);
      if (r !== "no_aplica") impuestosLc.candidatos++;
      if (r === "conciliado") {
        impuestosLc.conciliados++;
        matched++;
        continue;
      }
      if (r === "sin_declaracion") impuestosLc.sinDeclaracion++;
      else if (r === "ambiguo") impuestosLc.ambiguos++;
    } catch {
      // best-effort: si el match de impuestos falla, se sigue con facturas
    }

    const absAmount = Math.abs(tx.monto);
    const isCreditTx = tx.monto > 0;

    // CRÉDITOS (entra dinero) → facturas INGRESO (clientes nos pagan)
    // DÉBITOS  (sale dinero)  → facturas EGRESO  (pagamos a proveedores) y
    //                           también RECIBOS DE NÓMINA.
    //
    // El recibo de nómina es tipo NOMINA, no EGRESO, y con el filtro anterior
    // JAMÁS entraba al pool: la dispersión de la quincena quedaba sin conciliar
    // aunque su recibo estuviera ahí, con el mismo RFC y el mismo día. La mesa
    // sí los ofrecía (se corrigió en su propia consulta), así que el usuario
    // veía la coincidencia «alta» y tenía que aplicarla a mano una por una.
    // postMonth ya sabe qué hacer con el match NOMINA: liquida Acreedores
    // diversos, que es donde el recibo provisionó.
    const tiposCandidatos: ("INGRESO" | "EGRESO" | "NOMINA")[] = isCreditTx
      ? ["INGRESO"]
      : ["EGRESO", "NOMINA"];

    const windowStart = new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000);
    const windowEnd = new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000);

    const candidates = await prisma.invoice.findMany({
      where: {
        companyId,
        tipo: { in: tiposCandidatos },
        status: "STAMPED",
        fecha: { gte: windowStart, lte: windowEnd },
        total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
        // Que no esté ya conciliada con otra transacción bancaria: ni por el
        // vínculo legado 1:1 ni por porciones asignadas (ConciliacionDetalle).
        bankTransactions: { none: { status: "MATCHED" } },
        conciliacionDetalles: { none: {} },
      },
      // contraparteNombre/Rfc: la contraparte del CFDI mismo (backfilleada del
      // rawXml). Los EGRESO sincronizados del SAT casi nunca tienen `customer`
      // — sin este respaldo, TODA la identidad se apagaba justo en el lado de
      // proveedores, que es donde más movimientos hay.
      include: { customer: { select: { rfc: true, razonSocial: true } } },
    });

    // ── Ventana ancha CUANDO HAY RFC ──────────────────────────────────────
    // Los 14 días son un sustituto de la confianza: sin saber quién es la
    // contraparte, la cercanía de fechas es casi lo único que respalda un
    // match automático. Cuando el RFC empata ese sustituto sobra — el RFC
    // vale 120 puntos, más que el importe exacto, porque identifica a la
    // PERSONA. Y pagar a 30 o 60 días es lo normal: la factura existe, con su
    // importe al centavo y su RFC, sólo que lleva un mes emitida.
    //
    // Medido sobre 239 movimientos pendientes de un hospital: a 14 días se
    // conciliaban solos CERO; con esta ventana, cinco — con puntajes de 200,
    // 260, 260 y 340, o sea sostenidos por RFC y folio, no por adivinar con
    // monto y fecha. Entre ellos pagos de $268,184.33 y $131,291.61.
    //
    // Lo que NO se relaja es el importe: sigue al ±1 %. Esto ensancha sólo la
    // fecha, y sólo para quien ya está identificado. Si aparecen dos facturas
    // del mismo RFC y el mismo importe, el desempate por ambigüedad las frena
    // igual que siempre.
    if (tx.contraparteRfc) {
      const porRfc = await prisma.invoice.findMany({
        where: {
          companyId,
          tipo: { in: tiposCandidatos },
          status: "STAMPED",
          fecha: {
            gte: new Date(tx.fecha.getTime() - IDENTITY_WINDOW_DAYS * 86400000),
            lte: new Date(tx.fecha.getTime() + IDENTITY_WINDOW_DAYS * 86400000),
          },
          total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
          bankTransactions: { none: { status: "MATCHED" } },
          conciliacionDetalles: { none: {} },
          OR: [
            { contraparteRfc: { equals: tx.contraparteRfc, mode: "insensitive" } },
            { customer: { rfc: { equals: tx.contraparteRfc, mode: "insensitive" } } },
          ],
        },
        include: { customer: { select: { rfc: true, razonSocial: true } } },
      });
      const yaEsta = new Set(candidates.map((c) => c.id));
      for (const inv of porRfc) if (!yaEsta.has(inv.id)) candidates.push(inv);
    }

    if (candidates.length === 0) continue;

    // ¿A qué CLABEs ya le habíamos pagado/cobrado a este cliente? Una CLABE que
    // ya se vio en un movimiento CONCILIADO con el mismo RFC identifica la
    // cuenta de esa contraparte. Se consulta sólo si el movimiento trae CLABE,
    // para no pagar la consulta en los que no la traen.
    const clabesPorRfc = tx.contraparteClabe
      ? await clabesConocidasPorRfc(companyId, tx.contraparteClabe)
      : new Set<string>();

    const senales = {
      fecha: tx.fecha,
      descripcion: tx.descripcion,
      contraparteRfc: tx.contraparteRfc,
      contraparteNombre: tx.contraparteNombre,
      contraparteClabe: tx.contraparteClabe,
    };

    // El bono de importe único se calcula UNA vez sobre todo el pool y se
    // acredita sólo al candidato que empata al centavo.
    // Lote de terminal: el sufijo de la afiliación dice si fue crédito o débito.
    const tarjetaLote = tarjetaDeLiquidacion(tx.descripcion);
    const enLote = tarjetaLote !== null;
    const bono = bonoImporteUnico(absAmount, candidates.map((c) => Number(c.total)), { enLoteTerminal: enLote });

    const scored = candidates
      .map((inv) => {
        // Identidad efectiva de la factura: el Customer si existe; si no, la
        // contraparte del propio CFDI (rawXml). Sin este respaldo la identidad
        // se apagaba en los EGRESO del SAT, que casi nunca tienen Customer.
        const rfcFactura = inv.customer?.rfc ?? inv.contraparteRfc ?? null;
        const nombreFactura = inv.customer?.razonSocial ?? inv.contraparteNombre ?? null;
        return {
          inv,
          score: scoreCandidate(
            {
              total: Number(inv.total),
              fecha: inv.fecha,
              customerRfc: rfcFactura,
              customerNombre: nombreFactura,
              serie: inv.serie,
              folio: inv.folio,
              clabesConocidas:
                rfcFactura && clabesPorRfc.has(rfcFactura) && tx.contraparteClabe
                  ? [tx.contraparteClabe]
                  : [],
            },
            senales,
            absAmount,
          ) + (bono && mismoImporte(Number(inv.total), absAmount, enLote) ? bono : 0)
            - (tarjetaContradice(tarjetaLote, inv.formaPago) ? CASTIGO_TARJETA_CONTRARIA : 0)
            - (cercaPeroNoExactoEnLote(enLote, Number(inv.total), absAmount) ? CASTIGO_CERCA_EN_LOTE : 0),
        };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const secondBest = scored[1];

    if (isAutoApplicable(best.score, secondBest?.score ?? null)) {
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { status: "MATCHED", invoiceId: best.inv.id },
      });
      matched++;
    }
  }

  return { matched, total: unmatched.length, impuestosLc };
}

// Auto-concilia todas las cuentas bancarias de una empresa. Best-effort: un
// error en una cuenta no detiene las demás.
export async function autoConciliarEmpresa(
  companyId: string,
): Promise<{ matched: number; accounts: number; impuestosLc: ImpuestosLcStats; rep: RepStats; traspasos: number }> {
  // ── PRIMERO EL REP ────────────────────────────────────────────────────────
  // El complemento de pago DICE qué facturas liquidó un pago y cuánto a cada
  // una: es evidencia firmada por el emisor, no inferencia nuestra. Corre
  // antes del scoring para que un pago que liquida 21 facturas no compita por
  // parecerse a UNA — ningún ranking por monto puede resolver ese caso, y
  // además el desglose es lo único que reparte bien el IVA al flujo.
  const rep: RepStats = { conciliados: 0, facturas: 0, ambiguos: 0 };
  let traspasos = 0;
  try {
    const r = await conciliarPorRepEmpresa(companyId, { aplicar: true });
    rep.conciliados = r.conciliados;
    rep.facturas = r.facturasAplicadas;
    rep.ambiguos = r.ambiguos;
  } catch (e) {
    console.error(`[auto-conciliar] REP falló para ${companyId}:`, e);
  }

  // ── TRASPASOS ENTRE CUENTAS PROPIAS ───────────────────────────────────────
  // Antes de buscarles factura: no la tienen. El banco no dice a dónde fue el
  // dinero («COMPRA ORDEN DE PAGO SPEI» no nombra cuenta destino), pero la otra
  // pata ya está importada — si una cuenta muestra −$230,000 y otra de la misma
  // empresa +$230,000 el mismo día, ese par es el traspaso.
  try {
    const t = await detectarTraspasosEmpresa(companyId, { aplicar: true });
    traspasos = t.etiquetados;
  } catch (e) {
    console.error(`[auto-conciliar] traspasos espejo falló para ${companyId}:`, e);
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
  });

  let matched = 0;
  const impuestosLc: ImpuestosLcStats = { candidatos: 0, conciliados: 0, sinDeclaracion: 0, ambiguos: 0 };
  for (const acc of accounts) {
    try {
      const res = await autoConciliarCuenta(acc.id);
      matched += res.matched;
      impuestosLc.candidatos += res.impuestosLc.candidatos;
      impuestosLc.conciliados += res.impuestosLc.conciliados;
      impuestosLc.sinDeclaracion += res.impuestosLc.sinDeclaracion;
      impuestosLc.ambiguos += res.impuestosLc.ambiguos;
    } catch {
      // best-effort: continuar con las demás cuentas
    }
  }

  return { matched: matched + rep.conciliados, accounts: accounts.length, impuestosLc, rep, traspasos };
}
