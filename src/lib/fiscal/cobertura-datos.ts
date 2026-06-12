// ─────────────────────────────────────────────────────────────────────────────
// Cobertura de datos fiscales — chequeo TIME-AWARE de frescura.
//
// El cálculo nunca adivina: ante un dato faltante cae a nominal / verificado:
// false. Pero eso no distingue "aún no se publica" de "ya se publicó y no lo
// tenemos". ESTE módulo sí: dado `asOf` (el reloj del servidor) y la cadencia de
// publicación de cada dataset, clasifica cada uno en:
//
//   al_dia       — el último periodo esperado ya está cargado y cotejado
//   por_publicar — el siguiente periodo aún no llega a su fecha de publicación
//   faltante     — un periodo cuya publicación YA pasó no está cargado (alerta)
//   sin_cotejar  — cargado pero verificado:false (revisar contra la fuente)
//
// Es deliberadamente lo único del sistema que depende del reloj — su trabajo es
// precisamente "¿qué debería haber hoy que no está?". Una correctitud (cifras
// declaradas) nunca depende de esto.
// ─────────────────────────────────────────────────────────────────────────────

import { coberturaInpc, INPC_VERIFICADO } from "./inpc";
import {
  coberturaTarifaAnualPF,
  coberturaTarifaMensualSueldos,
  coberturaSubsidioEmpleo,
} from "./tarifas";
import { UMA_EJERCICIO, SALARIO_MINIMO_EJERCICIO } from "../nomina/constants";

export type EstadoCobertura = "al_dia" | "por_publicar" | "faltante" | "sin_cotejar";

export interface CoberturaDataset {
  clave: string;
  nombre: string;
  /** "mensual" (INPC) o "anual" (tarifas, UMA, SM, subsidio). */
  periodicidad: "mensual" | "anual";
  estado: EstadoCobertura;
  /** Último periodo cargado, legible ("2026-05" o "2026"). null si nada cargado. */
  ultimoCargado: string | null;
  /** Último periodo que YA debería estar publicado a la fecha `asOf`. */
  ultimoEsperado: string;
  verificado: boolean;
  detalle: string;
}

// ── Cadencias de publicación ────────────────────────────────────────────────
// INPC: el índice de un mes se publica ~día 9 del mes SIGUIENTE (la quincena ~24
// del mismo mes; usamos el dato mensual firme).
const INPC_DIA_PUBLICACION = 9;

interface CadenciaAnual {
  /** Mes (1-12) y día en que se publica para su ejercicio de vigencia. */
  mes: number;
  dia: number;
  /** True si se publica en el año ANTERIOR al de vigencia (p.ej. tarifa en dic). */
  delAnioAnterior: boolean;
}

function addMonths(year: number, month1: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month1 - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** Último periodo mensual cuya fecha de publicación (día N del mes siguiente) ya pasó. */
function ultimoEsperadoMensual(asOf: Date, dia: number): { year: number; month: number } {
  let cand = addMonths(asOf.getFullYear(), asOf.getMonth() + 1, -1); // mes anterior al de asOf
  for (let i = 0; i < 36; i++) {
    const due = new Date(cand.year, cand.month, dia); // día `dia` del mes SIGUIENTE al periodo
    if (due <= asOf) return cand;
    cand = addMonths(cand.year, cand.month, -1);
  }
  return cand;
}

function dueDateAnual(ejercicio: number, c: CadenciaAnual): Date {
  const baseYear = c.delAnioAnterior ? ejercicio - 1 : ejercicio;
  return new Date(baseYear, c.mes - 1, c.dia);
}

/** Último ejercicio cuya fecha de publicación ya pasó a la fecha `asOf`. */
function ultimoEsperadoAnual(asOf: Date, c: CadenciaAnual): number {
  for (let y = asOf.getFullYear() + 1; y >= asOf.getFullYear() - 5; y--) {
    if (dueDateAnual(y, c) <= asOf) return y;
  }
  return asOf.getFullYear();
}

const periodoMensual = (p: { year: number; month: number }) => `${p.year}-${String(p.month).padStart(2, "0")}`;
const ordMensual = (p: { year: number; month: number }) => p.year * 12 + p.month;

function evaluarMensual(
  clave: string, nombre: string, asOf: Date, dia: number,
  cargado: { year: number; month: number } | null, verificado: boolean
): CoberturaDataset {
  const esperado = ultimoEsperadoMensual(asOf, dia);
  let estado: EstadoCobertura;
  let detalle: string;
  if (!cargado) {
    estado = "faltante";
    detalle = "Sin ningún periodo cargado.";
  } else if (ordMensual(cargado) < ordMensual(esperado)) {
    estado = "faltante";
    const sig = addMonths(cargado.year, cargado.month, 1);
    detalle = `Falta desde ${periodoMensual(sig)} (su publicación ya pasó).`;
  } else if (!verificado) {
    estado = "sin_cotejar";
    detalle = "Al día en cobertura pero sin cotejar contra la fuente oficial.";
  } else {
    estado = "al_dia";
    detalle = "Último periodo publicado, cargado y cotejado.";
  }
  return {
    clave, nombre, periodicidad: "mensual", estado,
    ultimoCargado: cargado ? periodoMensual(cargado) : null,
    ultimoEsperado: periodoMensual(esperado), verificado, detalle,
  };
}

function evaluarAnual(
  clave: string, nombre: string, asOf: Date, cad: CadenciaAnual,
  cargadoEjercicio: number | null, verificado: boolean
): CoberturaDataset {
  const esperado = ultimoEsperadoAnual(asOf, cad);
  let estado: EstadoCobertura;
  let detalle: string;
  if (cargadoEjercicio == null) {
    estado = "faltante";
    detalle = "Sin ningún ejercicio cargado.";
  } else if (cargadoEjercicio < esperado) {
    estado = "faltante";
    detalle = `Falta el ejercicio ${esperado} (su publicación ya pasó); el último cargado es ${cargadoEjercicio}.`;
  } else if (!verificado) {
    estado = "sin_cotejar";
    detalle = `Ejercicio ${cargadoEjercicio} cargado pero sin cotejar.`;
  } else {
    estado = "al_dia";
    detalle = `Ejercicio ${esperado} cargado y cotejado.`;
  }
  return {
    clave, nombre, periodicidad: "anual", estado,
    ultimoCargado: cargadoEjercicio != null ? String(cargadoEjercicio) : null,
    ultimoEsperado: String(esperado), verificado, detalle,
  };
}

/**
 * Reporte de cobertura de todos los datasets fiscales versionados, a la fecha
 * `asOf` (default: ahora, hora del servidor).
 */
export function evaluarCoberturaFiscal(asOf: Date = new Date()): {
  asOf: string;
  datasets: CoberturaDataset[];
  resumen: { alDia: number; faltantes: number; sinCotejar: number };
} {
  const inpc = coberturaInpc();
  const tAnual = coberturaTarifaAnualPF();
  const tMensual = coberturaTarifaMensualSueldos();
  const subsidio = coberturaSubsidioEmpleo();

  // Tarifa/UMA/SM efectivas el ejercicio Y se publican en dic Y-1 / ene–feb Y.
  const TARIFA: CadenciaAnual = { mes: 12, dia: 28, delAnioAnterior: true }; // Anexo 8 RMF, DOF ~28-dic
  const SUBSIDIO: CadenciaAnual = { mes: 12, dia: 31, delAnioAnterior: true }; // decreto, fin de año
  const UMA: CadenciaAnual = { mes: 2, dia: 1, delAnioAnterior: false }; // INEGI, vigente 1-feb
  const SM: CadenciaAnual = { mes: 1, dia: 1, delAnioAnterior: false }; // CONASAMI, vigente 1-ene

  const datasets: CoberturaDataset[] = [
    evaluarMensual("INPC", "INPC (actualización de inversiones, Art. 31)", asOf, INPC_DIA_PUBLICACION, inpc, INPC_VERIFICADO),
    evaluarAnual("TARIFA_ISR_ANUAL", "Tarifa ISR anual PF (Art. 152)", asOf, TARIFA, tAnual?.ejercicio ?? null, tAnual?.verificado ?? false),
    evaluarAnual("TARIFA_ISR_MENSUAL", "Tarifa ISR mensual / sueldos (Art. 96/116)", asOf, TARIFA, tMensual?.ejercicio ?? null, tMensual?.verificado ?? false),
    evaluarAnual("SUBSIDIO_EMPLEO", "Subsidio para el empleo (decreto)", asOf, SUBSIDIO, subsidio?.ejercicio ?? null, subsidio?.verificado ?? false),
    evaluarAnual("UMA", "UMA (INEGI)", asOf, UMA, UMA_EJERCICIO, true),
    evaluarAnual("SALARIO_MINIMO", "Salario mínimo (CONASAMI)", asOf, SM, SALARIO_MINIMO_EJERCICIO, true),
  ];

  const resumen = {
    alDia: datasets.filter((d) => d.estado === "al_dia").length,
    faltantes: datasets.filter((d) => d.estado === "faltante").length,
    sinCotejar: datasets.filter((d) => d.estado === "sin_cotejar").length,
  };
  return { asOf: asOf.toISOString(), datasets, resumen };
}
