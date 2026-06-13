import { prisma } from "../prisma";
import { inpcCargados } from "./inpc";
import { fetchInpcBanxico, BANXICO_INPC_SERIE } from "./banxico";

// Cotejo del INPC cargado contra la fuente oficial (Banxico SIE, serie SP1).
// Compara cada mes que tenemos con el valor de Banxico; si TODOS empatan
// (tolerancia 0.001), marca el dataset verificado hasta el último mes cargado.
// Si alguno difiere, lo registra como mismatch y NO marca verificado.
// (INEGI no publica el INPC en su API de indicadores; Banxico sí.)

const TOLERANCIA = 0.0011; // INPC se publica a 3 decimales

export interface CotejoResultado {
  ok: boolean;
  verificado: boolean;
  cotejados: number;
  verifiedThrough: string | null;
  mismatches: { periodo: string; cargado: number; oficial: number }[];
  error?: string;
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
  const fuente = `Banxico SIE (serie ${BANXICO_INPC_SERIE})`;

  await prisma.cotejoFiscal.upsert({
    where: { dataset: "INPC" },
    create: {
      dataset: "INPC",
      verificado,
      verifiedThrough: verificado ? maxPeriodo : null,
      matchedAt: verificado ? new Date() : null,
      mismatch: mismatches.length > 0 ? mismatches : undefined,
      fuente,
    },
    update: {
      verificado,
      verifiedThrough: verificado ? maxPeriodo : null,
      matchedAt: verificado ? new Date() : null,
      mismatch: mismatches.length > 0 ? mismatches : undefined,
      fuente,
    },
  });

  return { ok: true, verificado, cotejados, verifiedThrough: verificado ? maxPeriodo : null, mismatches };
}
