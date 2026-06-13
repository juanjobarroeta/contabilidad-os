import { prisma } from "../prisma";
import { inpcCargados } from "./inpc";
import { fetchInpcInegi } from "./inegi";

// Cotejo del INPC cargado contra la fuente oficial (INEGI). Compara cada mes que
// tenemos con el valor de INEGI; si TODOS empatan (tolerancia 0.001), marca el
// dataset verificado hasta el último mes cargado. Si alguno difiere, lo registra
// como mismatch y NO marca verificado (para revisar). Persiste en CotejoFiscal.

const TOLERANCIA = 0.0011; // INPC se publica a 3 decimales

export interface CotejoResultado {
  ok: boolean;
  verificado: boolean;
  cotejados: number;
  verifiedThrough: string | null;
  mismatches: { periodo: string; cargado: number; inegi: number }[];
  error?: string;
}

export async function cotejarInpc(): Promise<CotejoResultado> {
  let inegi: Map<string, number>;
  try {
    inegi = await fetchInpcInegi();
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
  const mismatches: { periodo: string; cargado: number; inegi: number }[] = [];
  let cotejados = 0;
  let maxPeriodo: string | null = null;

  for (const { year, month, valor } of cargados) {
    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const oficial = inegi.get(periodo);
    if (oficial == null) continue; // INEGI no tiene ese mes (raro) — no lo contamos
    cotejados++;
    if (Math.abs(oficial - valor) > TOLERANCIA) {
      mismatches.push({ periodo, cargado: valor, inegi: oficial });
    } else if (!maxPeriodo || periodo > maxPeriodo) {
      maxPeriodo = periodo;
    }
  }

  const verificado = cotejados > 0 && mismatches.length === 0;

  await prisma.cotejoFiscal.upsert({
    where: { dataset: "INPC" },
    create: {
      dataset: "INPC",
      verificado,
      verifiedThrough: verificado ? maxPeriodo : null,
      matchedAt: verificado ? new Date() : null,
      mismatch: mismatches.length > 0 ? mismatches : undefined,
      fuente: "INEGI BIE",
    },
    update: {
      verificado,
      verifiedThrough: verificado ? maxPeriodo : null,
      matchedAt: verificado ? new Date() : null,
      mismatch: mismatches.length > 0 ? mismatches : undefined,
      fuente: "INEGI BIE",
    },
  });

  return { ok: true, verificado, cotejados, verifiedThrough: verificado ? maxPeriodo : null, mismatches };
}
