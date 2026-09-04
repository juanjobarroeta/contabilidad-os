import { prisma } from "../prisma";
import { inpcCargados } from "./inpc";
import { fetchInpcBanxico, BANXICO_INPC_SERIE } from "./banxico";
import { parseAnexo5 } from "./fuentes/anexo5";
import { parseAnexo8, tarifasCoinciden } from "./fuentes/anexo8";
import { fetchUma } from "./fuentes/inegi";
import { parseRecargosLif, urlLif } from "./fuentes/lif";
import { descargarAnexo } from "./fuentes/sat-anexos";
import { descargarBinario, textoDePdf } from "./fuentes/texto";
import { MULTAS_CFF } from "./multas";
import { RECARGOS } from "./recargos";
import { getRule } from "./rules";
import { tarifaAnualPF, tarifaMensualSueldos } from "./tarifas";

// ─────────────────────────────────────────────────────────────────────────────
// Cotejo de los datos fiscales versionados contra su fuente oficial. Cada
// dataset compara lo que hay en el código con lo que publica la autoridad y
// deja el veredicto en CotejoFiscal (una fila por dataset): empate → verificado
// hasta el último periodo/ejercicio cargado; diferencia → mismatch y NO
// verificado; ejercicio nuevo en la fuente que el código no tiene → mismatch
// «falta». La cobertura (/cumplimiento) sube «sin cotejar» → «al día» con esto.
//
//   INPC                → Banxico SIE serie SP1 (INEGI no expone el INPC en su API)
//   TARIFA_ISR_MENSUAL  → Anexo 8 RMF (PDF, minisitio del SAT), tarifa Art. 96
//   TARIFA_ISR_ANUAL    → Anexo 8 RMF, tarifa Art. 152 del ejercicio
//   MULTAS_CFF          → Anexo 5 RMF (PDF), fila por fila
//   RECARGOS            → LIF del ejercicio (Cámara de Diputados), Art. de recargos
//   UMA                 → boletín anual del INEGI (PDF, sin token); API si hay INEGI_TOKEN
//
// Los valores NUNCA se escriben desde aquí: el cotejo sólo confirma o avisa.
// ─────────────────────────────────────────────────────────────────────────────

const TOLERANCIA = 0.0011; // INPC se publica a 3 decimales

export interface CotejoResultado {
  ok: boolean;
  verificado: boolean;
  cotejados: number;
  verifiedThrough: string | null;
  mismatches: { periodo: string; cargado: number; oficial: number }[];
  error?: string;
}

async function guardar(dataset: string, verificado: boolean, verifiedThrough: string | null, mismatch: unknown, fuente: string) {
  const data = {
    verificado,
    verifiedThrough: verificado ? verifiedThrough : null,
    matchedAt: verificado ? new Date() : null,
    mismatch: mismatch === undefined ? undefined : (mismatch as object),
    fuente,
  };
  await prisma.cotejoFiscal.upsert({ where: { dataset }, create: { dataset, ...data }, update: data });
}

export async function cotejarInpc(): Promise<CotejoResultado> {
  let oficial: Map<string, number>;
  try {
    oficial = await fetchInpcBanxico();
  } catch (e) {
    return {
      ok: false,
      verificado: false,
      cotejados: 0,
      verifiedThrough: null,
      mismatches: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const cargados = inpcCargados();
  const mismatches: { periodo: string; cargado: number; oficial: number }[] = [];
  let cotejados = 0;
  let maxPeriodo: string | null = null;

  for (const { year, month, valor } of cargados) {
    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const off = oficial.get(periodo);
    if (off == null) continue; // la fuente no tiene ese mes — no lo contamos
    cotejados++;
    if (Math.abs(off - valor) > TOLERANCIA) {
      mismatches.push({ periodo, cargado: valor, oficial: off });
    } else if (!maxPeriodo || periodo > maxPeriodo) {
      maxPeriodo = periodo;
    }
  }

  const verificado = cotejados > 0 && mismatches.length === 0;
  await guardar("INPC", verificado, maxPeriodo, mismatches.length > 0 ? mismatches : undefined, `Banxico SIE (serie ${BANXICO_INPC_SERIE})`);
  return { ok: true, verificado, cotejados, verifiedThrough: verificado ? maxPeriodo : null, mismatches };
}

// ── Datasets anuales ─────────────────────────────────────────────────────────

export interface CotejoAnual {
  dataset: string;
  ok: boolean;
  verificado: boolean;
  ejercicio: number;
  fuente: string | null;
  diferencias: string[];
  /** true cuando la fuente ya publicó un ejercicio que el código no tiene. */
  falta?: boolean;
  skipped?: string;
  error?: string;
}

function ejercicioObjetivo(hoy = new Date()): number {
  // De mediados de diciembre en adelante ya se publican los valores del año siguiente.
  return hoy.getUTCFullYear() + (hoy.getUTCMonth() === 11 && hoy.getUTCDate() >= 15 ? 1 : 0);
}

async function correr(dataset: string, fn: () => Promise<Omit<CotejoAnual, "dataset" | "ok">>): Promise<CotejoAnual> {
  try {
    const r = await fn();
    if (!r.skipped) await guardar(dataset, r.verificado, r.verificado ? String(r.ejercicio) : null, r.diferencias.length ? r.diferencias : undefined, r.fuente ?? dataset);
    return { dataset, ok: true, ...r };
  } catch (e) {
    return { dataset, ok: false, verificado: false, ejercicio: 0, fuente: null, diferencias: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Multas del CFF vs Anexo 5 (fila por fila: ubicación + montos). */
export function cotejarMultas(ejercicio = ejercicioObjetivo(), url?: string): Promise<CotejoAnual> {
  return correr("MULTAS_CFF", async () => {
    const enCodigo = MULTAS_CFF.find((m) => m.ejercicio === ejercicio);
    const a = await descargarAnexo(5, ejercicio, url ?? process.env.SAT_ANEXO5_URL);
    const p = parseAnexo5(a.texto);
    if (!enCodigo) return { verificado: false, ejercicio, fuente: a.url, diferencias: [`falta la tabla ${ejercicio} en el código (la fuente ya la publicó: ${p.filas.length} filas)`], falta: true };
    const clave = (f: { seccion: string; articulo: string; fraccion: string | null; inciso: string | null; minimo: number; maximo: number | null }) =>
      `${f.seccion}|${f.articulo}|${f.fraccion ?? ""}|${f.inciso ?? ""}|${f.minimo}|${f.maximo ?? ""}`;
    const oficial = new Set(p.filas.map(clave));
    const propio = new Set(enCodigo.filas.map(clave));
    const diferencias: string[] = [];
    for (const k of propio) if (!oficial.has(k)) diferencias.push(`en código, no en la fuente: ${k}`);
    for (const k of oficial) if (!propio.has(k)) diferencias.push(`en la fuente, no en código: ${k}`);
    return { verificado: diferencias.length === 0, ejercicio, fuente: a.url, diferencias: diferencias.slice(0, 50) };
  });
}

/** Tarifas ISR mensual (Art. 96) y anual (Art. 152) vs Anexo 8. Dos datasets. */
export async function cotejarTarifas(ejercicio = ejercicioObjetivo(), url?: string): Promise<CotejoAnual[]> {
  let texto: string;
  let fuente: string;
  try {
    const a = await descargarAnexo(8, ejercicio, url ?? process.env.SAT_ANEXO8_URL);
    texto = a.texto;
    fuente = a.url;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return ["TARIFA_ISR_MENSUAL", "TARIFA_ISR_ANUAL"].map((dataset) => ({ dataset, ok: false, verificado: false, ejercicio, fuente: null, diferencias: [], error }));
  }
  const p = parseAnexo8(texto);
  const mensual = await correr("TARIFA_ISR_MENSUAL", async () => {
    const of = p.tarifas.find((t) => t.periodo === "mensual");
    const cod = tarifaMensualSueldos(ejercicio);
    if (!of) return { verificado: false, ejercicio, fuente, diferencias: ["el Anexo 8 no trae la tarifa mensual reconocible"] };
    if (!cod || !cod.vigente || cod.tarifa.ejercicio !== ejercicio) return { verificado: false, ejercicio, fuente, diferencias: [`falta la tarifa mensual ${ejercicio} en tarifas.ts`], falta: true };
    const c = tarifasCoinciden(of.filas, cod.tarifa.filas);
    return { verificado: c.ok, ejercicio, fuente, diferencias: c.diferencias };
  });
  const anual = await correr("TARIFA_ISR_ANUAL", async () => {
    const of = p.tarifas.find((t) => t.periodo === "anual" && t.ejercicioTarifa === ejercicio);
    const cod = tarifaAnualPF(ejercicio);
    if (!of) return { verificado: false, ejercicio, fuente, diferencias: [`el Anexo 8 no trae la tarifa anual ${ejercicio}`] };
    if (!cod || cod.ejercicio !== ejercicio) return { verificado: false, ejercicio, fuente, diferencias: [`falta la tarifa anual ${ejercicio} en tarifas.ts`], falta: true };
    const c = tarifasCoinciden(of.filas, cod.filas);
    return { verificado: c.ok, ejercicio, fuente, diferencias: c.diferencias };
  });
  return [mensual, anual];
}

/** Recargos vs la LIF del ejercicio. */
export function cotejarRecargos(ejercicio = ejercicioObjetivo(), url?: string): Promise<CotejoAnual> {
  return correr("RECARGOS", async () => {
    const u = url ?? process.env.LIF_URL ?? urlLif(ejercicio);
    const r = parseRecargosLif(await textoDePdf(await descargarBinario(u)));
    if (!r) return { verificado: false, ejercicio, fuente: u, diferencias: ["no se encontró el artículo de recargos en la LIF"] };
    const cod = RECARGOS.find((x) => x.ejercicio === ejercicio);
    if (!cod) return { verificado: false, ejercicio, fuente: u, diferencias: [`falta recargos-${ejercicio}.json (la LIF ${r.ejercicio} ya está publicada)`], falta: true };
    const diferencias: string[] = [];
    if (Math.abs(cod.prorroga - r.prorroga) > 1e-6) diferencias.push(`prórroga ${cod.prorroga} vs ${r.prorroga}`);
    const a = cod.parcialidades.map((x) => x.tasa).join(",");
    const b = r.parcialidades.map((x) => x.tasa).join(",");
    if (a !== b) diferencias.push(`parcialidades ${a} vs ${b}`);
    return { verificado: diferencias.length === 0, ejercicio, fuente: u, diferencias };
  });
}

/** UMA del catálogo vs el boletín anual del INEGI (y la API si hay token). */
export function cotejarUma(ejercicio = ejercicioObjetivo()): Promise<CotejoAnual> {
  return correr("UMA", async () => {
    const of = await fetchUma(ejercicio);
    const fuente = of.fuente ?? "INEGI";
    const cod = getRule<{ diaria: number; mensual: number; anual: number }>("uma.valor", { regimen: "601", actividades: [], tipoPersona: "PM", fecha: `${ejercicio}-02-15` });
    if (!cod) return { verificado: false, ejercicio, fuente, diferencias: [`falta uma.valor ${ejercicio} en catalog.ts (INEGI: ${of.diaria})`], falta: true };
    const diferencias: string[] = [];
    if (Math.abs(cod.valor.diaria - of.diaria) > 0.005) diferencias.push(`diaria ${cod.valor.diaria} vs ${of.diaria}`);
    if (of.mensual != null && Math.abs(cod.valor.mensual - of.mensual) > 0.005) diferencias.push(`mensual ${cod.valor.mensual} vs ${of.mensual}`);
    if (of.anual != null && Math.abs(cod.valor.anual - of.anual) > 0.005) diferencias.push(`anual ${cod.valor.anual} vs ${of.anual}`);
    return { verificado: diferencias.length === 0, ejercicio, fuente, diferencias };
  });
}

/** Corre todos los cotejos (cada uno falla por separado; ninguno tumba a los demás). */
export async function cotejarTodo(ejercicio = ejercicioObjetivo()): Promise<{ inpc: CotejoResultado | { skipped: string }; anuales: CotejoAnual[] }> {
  const inpc = process.env.BANXICO_TOKEN ? await cotejarInpc() : { skipped: "BANXICO_TOKEN no configurado" };
  const anuales = [await cotejarMultas(ejercicio), ...(await cotejarTarifas(ejercicio)), await cotejarRecargos(ejercicio), await cotejarUma(ejercicio)];
  return { inpc, anuales };
}
