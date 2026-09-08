import Anthropic from "@anthropic-ai/sdk";
import type { ParsedTransaction } from "@/lib/bank-parser";
import { meteredCreate } from "@/lib/costos/anthropic";
import type { CostCtx } from "@/lib/costos/record";
import { leerPdf, PAGINAS_POR_LOTE, rangosDeLotes, recortarPaginas } from "./pdf-paginas";
import { cotejarControles, leerControles, type CotejoControles } from "./controles-estado";

// ─────────────────────────────────────────────────────────────────────────────
// Extracción de un estado de cuenta (PDF o foto) con visión.
//
// Se usa cuando no hay CSV/OFX — sólo el PDF o una foto. Se le pide al modelo
// los movimientos MÁS los saldos, y luego se VALIDA. Una extracción financiera
// nunca se importa a ciegas.
//
// POR QUÉ ESTÁ ESCRITO POR LOTES DE PÁGINAS. Antes se mandaba el PDF entero en
// UNA llamada con `max_tokens: 8000`. Un estado de cuenta real —17 páginas, 168
// movimientos— son ~20 000 tokens de JSON: la respuesta se cortaba a la mitad,
// `JSON.parse` fallaba y el usuario leía «intenta con un archivo más claro»,
// culpando a su archivo de un techo nuestro. Uno de 267 renglones ni siquiera
// terminaba antes de los 120 s de la ruta, y se veía como un timeout.
//
// Ahora el PDF se corta en lotes de páginas y los lotes corren EN PARALELO: la
// salida de cada llamada es chica (ninguna se acerca al techo) y el tiempo total
// es el del lote más lento, no la suma. Si aun así una respuesta llegara al
// tope, se dice EXACTAMENTE eso en vez de culpar al archivo.
//
// Y COMO LA EXTRACCIÓN AHORA VA PARTIDA, EL CANDADO SUBIÓ. El de saldos
// (inicial + Σ ≈ final) tiene un hueco: si se escapan un cargo y un abono del
// mismo importe, la suma cuadra igual. Con lotes, además, un lote que falle a
// medias se nota antes en el conteo que en el saldo. Por eso se coteja también
// contra los TOTALES DE CONTROL que el banco imprime —cuántos depósitos,
// cuántos retiros y por cuánto cada lado— que es el control fuerte. Ver
// `controles-estado.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();
const MODEL = "claude-sonnet-4-5";
const BALANCE_TOLERANCE = 1.0; // MXN; rounding slack on the reconciliation check
// Techo por lote. Un lote de 4 páginas son ~45 movimientos ≈ 6 000 tokens de
// JSON; 16 000 deja margen de sobra para que la respuesta NUNCA se trunque.
const MAX_TOKENS_LOTE = 16000;

const SYSTEM_PROMPT = `Eres un experto en estados de cuenta bancarios mexicanos (BBVA, Banamex, Santander, Banorte, HSBC, Scotiabank, etc.). Extrae los movimientos y los saldos en JSON, sin explicaciones.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, nada de markdown.
2. Convención de signo: monto POSITIVO = depósito/abono (entra dinero), NEGATIVO = cargo/retiro (sale dinero).
3. Montos como números sin símbolos ni comas (12345.67, no "$12,345.67").
4. Fechas en formato ISO YYYY-MM-DD. Infiere el año del periodo del estado de cuenta.
5. Extrae TODOS los movimientos, en orden cronológico.
6. Extrae el saldo inicial y el saldo final del periodo tal como aparecen.
7. Si un dato no aparece, usa null. NO inventes.

SCHEMA:
{
  "banco": string | null,
  "numeroCuenta": string | null,
  "periodo": string | null,
  "saldoInicial": number | null,
  "saldoFinal": number | null,
  "movimientos": [
    { "fecha": "YYYY-MM-DD", "descripcion": string, "monto": number, "referencia": string | null, "saldo": number | null }
  ]
}`;

const USER_PROMPT = "Extrae los movimientos y saldos de este estado de cuenta siguiendo el schema exacto. Solo JSON.";

export interface StatementExtraction {
  banco: string | null;
  numeroCuenta: string | null;
  periodo: string | null;
  transactions: ParsedTransaction[];
  balanceCheck: {
    saldoInicial: number | null;
    saldoFinal: number | null;
    sumaMovimientos: number;
    esperadoFinal: number | null;
    cuadra: boolean | null; // null when balances weren't found
    diferencia: number | null;
  };
  /** Cotejo contra los totales que el propio banco imprime. `cuadra: null` =
   *  su formato no los trae y no hubo con qué cotejar — que no es «cuadró». */
  controles: CotejoControles | null;
  /** En cuántos lotes de páginas se partió el documento (1 = una sola llamada). */
  lotes: number;
  warnings: string[];
}

type RawExtraction = {
  banco: string | null;
  numeroCuenta: string | null;
  periodo: string | null;
  saldoInicial: number | null;
  saldoFinal: number | null;
  movimientos: {
    fecha: string;
    descripcion: string;
    monto: number;
    referencia: string | null;
    saldo: number | null;
  }[];
};

/** Extract + validate a bank statement from a PDF/image buffer.
 *  `costCtx` (opcional, aditivo) atribuye el costo LLM a una empresa/subtipo —
 *  el flujo de WhatsApp lo usa para que la visión cuente contra el presupuesto
 *  mensual de la empresa; sin él se mide como antes (bancos.vision_statement,
 *  sin empresa). */
export async function extractStatementFromDocument(
  buf: Buffer,
  mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp",
  costCtx?: CostCtx
): Promise<StatementExtraction> {
  // Texto del PDF: NO para leer los movimientos —la diferencia entre cargo y
  // abono vive en la POSICIÓN de la columna y aplanar el PDF la pierde— sino
  // para saber cuántas páginas tiene y leer los totales de control del banco.
  const leido = mediaType === "application/pdf" ? await leerPdf(buf) : null;
  const controles = leido ? leerControles(leido.texto) : null;
  const paginas = leido?.paginas ?? 0;

  // Un documento corto (o una foto, o un PDF escaneado sin texto) va en una
  // sola llamada, como siempre. Sólo se parte lo que de verdad lo necesita.
  const rangos =
    mediaType === "application/pdf" && paginas > PAGINAS_POR_LOTE
      ? rangosDeLotes(paginas)
      : [];

  const warnings: string[] = [];
  let raws: RawExtraction[];

  if (rangos.length > 1) {
    // Los lotes son independientes: se recortan y se piden EN PARALELO. El
    // tiempo total pasa a ser el del lote más lento.
    const recortes = await Promise.all(
      rangos.map(async ([desde, hasta]) => ({
        desde,
        hasta,
        pdf: await recortarPaginas(buf, desde, hasta),
      })),
    );
    // Si qpdf no pudo recortar, se cae al documento completo antes que fallar:
    // peor extracción es mejor que ninguna, y los controles lo delatarán.
    if (recortes.some((r) => !r.pdf)) {
      warnings.push("No se pudo partir el PDF por páginas; se extrajo completo.");
      raws = [await extraerDeDocumento(buf, mediaType, costCtx, null)];
    } else {
      raws = await Promise.all(
        recortes.map((r) =>
          extraerDeDocumento(r.pdf!, "application/pdf", costCtx, [r.desde, r.hasta]),
        ),
      );
    }
  } else {
    raws = [await extraerDeDocumento(buf, mediaType, costCtx, null)];
  }

  // Los saldos y los datos de la cuenta viven en el resumen de la primera
  // página, así que salen del primer lote; los movimientos se concatenan en el
  // orden de las páginas. NO se deduplican: dos SPEI idénticos el mismo día son
  // dos movimientos reales, y borrar uno sería inventar. Si un renglón partido
  // entre dos páginas se contara dos veces, lo delata el conteo del banco.
  const cabeza = raws.find((r) => r.saldoInicial != null) ?? raws[0];
  const raw: RawExtraction = {
    banco: raws.find((r) => r.banco)?.banco ?? null,
    numeroCuenta: raws.find((r) => r.numeroCuenta)?.numeroCuenta ?? null,
    periodo: raws.find((r) => r.periodo)?.periodo ?? null,
    saldoInicial: cabeza?.saldoInicial ?? null,
    saldoFinal: raws.map((r) => r.saldoFinal).filter((v) => v != null).pop() ?? null,
    movimientos: raws.flatMap((r) => r.movimientos ?? []),
  };

  const transactions: ParsedTransaction[] = (raw.movimientos ?? [])
    .filter((m) => m && m.fecha && typeof m.monto === "number")
    .map((m) => {
      const d = new Date(`${m.fecha}T12:00:00`);
      return {
        fecha: d,
        descripcion: (m.descripcion ?? "").trim() || "Movimiento",
        monto: m.monto,
        referencia: m.referencia ?? undefined,
        saldo: typeof m.saldo === "number" ? m.saldo : undefined,
      };
    })
    .filter((t) => !isNaN(t.fecha.getTime()));

  if (transactions.length === 0) {
    warnings.push("No se detectaron movimientos en el documento.");
  }

  // ── Candado 1: los totales que el banco imprime ───────────────────────────
  // Es el fuerte, porque compara los dos lados POR SEPARADO y —en BBVA— trae
  // el CONTEO: si el banco dice 126 retiros y hay 119, faltan siete y se sabe.
  const cotejo = controles ? cotejarControles(controles, transactions) : null;
  if (cotejo?.advertencias.length) warnings.push(...cotejo.advertencias);

  // ── Candado 2: saldo inicial + Σ movimientos ≈ saldo final ────────────────
  const sumaMovimientos = round2(transactions.reduce((s, t) => s + t.monto, 0));
  let cuadra: boolean | null = null;
  let esperadoFinal: number | null = null;
  let diferencia: number | null = null;
  if (raw.saldoInicial != null && raw.saldoFinal != null) {
    esperadoFinal = round2(raw.saldoInicial + sumaMovimientos);
    diferencia = round2(esperadoFinal - raw.saldoFinal);
    cuadra = Math.abs(diferencia) <= BALANCE_TOLERANCE;
    if (!cuadra) {
      warnings.push(
        `Los saldos no cuadran: inicial ${fmt(raw.saldoInicial)} + movimientos ${fmt(sumaMovimientos)} = ${fmt(esperadoFinal)}, pero el estado dice ${fmt(raw.saldoFinal)} (diferencia ${fmt(diferencia)}). Revisa antes de importar — pueden faltar o sobrar movimientos.`
      );
    }
  } else if (!cotejo || cotejo.cuadra === null) {
    // Sólo se dice «no hubo con qué validar» cuando NINGUNO de los dos candados
    // pudo correr. Con los totales del banco cotejados, sobra.
    warnings.push("No se encontraron saldos ni totales de control para validar la extracción. Revisa los movimientos manualmente.");
  }

  return {
    banco: raw.banco ?? null,
    numeroCuenta: raw.numeroCuenta ?? null,
    periodo: raw.periodo ?? null,
    transactions,
    balanceCheck: {
      saldoInicial: raw.saldoInicial ?? null,
      saldoFinal: raw.saldoFinal ?? null,
      sumaMovimientos,
      esperadoFinal,
      cuadra,
      diferencia,
    },
    controles: cotejo,
    lotes: rangos.length > 1 ? rangos.length : 1,
    warnings,
  };
}

/** Una llamada de extracción. `rango` acota a un lote de páginas del original
 *  (sólo para redactar el prompt: el PDF que se manda YA viene recortado). */
async function extraerDeDocumento(
  buf: Buffer,
  mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp",
  costCtx: CostCtx | undefined,
  rango: [number, number] | null,
): Promise<RawExtraction> {
  const base64 = buf.toString("base64");
  const docBlock: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any;
  try {
    response = await meteredCreate(anthropic, { subtipo: "bancos.vision_statement", ...costCtx }, {
      model: MODEL,
      max_tokens: MAX_TOKENS_LOTE,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            docBlock,
            {
              type: "text",
              text: rango
                ? `${USER_PROMPT} Este archivo es un FRAGMENTO del estado de cuenta (páginas ${rango[0]} a ${rango[1]} del original): extrae únicamente los movimientos que aparezcan aquí, y deja en null los saldos que no vengan en estas páginas.`
                : USER_PROMPT,
            },
          ],
        },
      ],
    });
  } catch (e) {
    // El error crudo de la API (JSON con request_id) es ilegible en un toast:
    // se traduce a un mensaje accionable y el detalle queda en el log.
    console.error("vision-statement: error de la API de extracción", e);
    if (e instanceof Anthropic.APIError) {
      const msg = String(e.message ?? "");
      if (/password|encrypted/i.test(msg)) {
        throw new Error(
          "El PDF está protegido con contraseña. Súbelo desde Bancos e ingresa la contraseña cuando se te pida."
        );
      }
      if (e.status === 400) {
        throw new Error("No se pudo leer el documento (¿está dañado o escaneado muy borroso?). Intenta con otro archivo o el CSV del banco.");
      }
      throw new Error("El servicio de extracción no está disponible en este momento. Intenta de nuevo en unos minutos.");
    }
    throw new Error("No se pudo procesar el documento. Intenta de nuevo.");
  }

  // Que la respuesta llegue al techo es un problema NUESTRO, no del archivo.
  // Decirlo con su nombre es lo que faltaba: durante meses este caso salió como
  // «intenta con un archivo más claro» sobre PDFs perfectamente legibles.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "El estado de cuenta trae más movimientos de los que caben en una lectura. " +
      "Es una limitación nuestra, no de tu archivo: repórtalo para subir el corte por páginas."
    );
  }

  const text =
    response.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(cleaned) as RawExtraction;
  } catch {
    throw new Error("No se pudo leer el estado de cuenta. Intenta con un archivo más claro o el CSV/Excel del banco.");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmt(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}
