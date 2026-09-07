// ─────────────────────────────────────────────────────────────────────────────
// LA TARJETA QUE EL PASO YA PODÍA PONER.
//
// La apertura de un paso es una sola llamada al modelo SIN herramientas: por
// eso podía escribir «firma la conciliación del mes» y no dejar nada que tocar.
// El contador leía una instrucción y salía a buscar el botón.
//
// Aquí se decide, sin modelo, qué propuesta corresponde al paso a partir de sus
// SEÑALES, y se invoca la MISMA herramienta `proponer_*` que usaría el copiloto.
// La herramienta valida (y rechaza si no procede); nosotros probamos las
// candidatas en orden y nos quedamos con la primera que quede en pie.
//
// No cambia el contrato: proponer no es ejecutar. La tarjeta aparece sola, pero
// nada pasa hasta que el humano toca Confirmar.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClavePasoCierre } from "./claves";
import type { PasoConDecision } from "./evaluar";

/** Herramientas candidatas por paso, en orden de preferencia. */
const CANDIDATAS: Partial<Record<ClavePasoCierre, { senal: string; tools: string[] }[]>> = {
  apertura: [
    { senal: "x:coeficiente", tools: ["proponer_fijar_coeficiente"] },
    // Las pérdidas y el saldo a favor: la tool lee la anual y decide si hay
    // valor que proponer; si la anual no reporta nada, se rechaza sola.
    { senal: "x:datos_apertura", tools: ["proponer_fijar_perdida"] },
    { senal: "fx:apertura", tools: ["proponer_confirmar_apertura"] },
  ],
  banco: [{ senal: "x:firmas_conciliacion", tools: ["proponer_firmar_conciliacion"] }],
};

/**
 * Qué herramientas vale la pena intentar para este paso, dadas sus señales.
 * PURA: sólo mira el estado de las señales. Devuelve [] cuando no hay nada que
 * proponer (paso limpio, ya decidido o sin candidatas).
 */
export function toolsAProbar(paso: PasoConDecision): string[] {
  if (paso.estado === "CONFIRMADO" || paso.estado === "OMITIDO") return [];
  if (paso.estadoCalculado === "no_aplica" || paso.estadoCalculado === "espera") return [];
  const reglas = CANDIDATAS[paso.clave];
  if (!reglas) return [];
  const out: string[] = [];
  for (const r of reglas) {
    const s = paso.senales.find((x) => x.clave === r.senal);
    if (!s || s.estado === "ok" || s.estado === "na") continue;
    for (const t of r.tools) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Tipo de pending action que deja cada herramienta (para no repetir tarjeta). */
export const TIPO_DE_TOOL: Record<string, string> = {
  proponer_fijar_coeficiente: "fijar_coeficiente",
  proponer_fijar_perdida: "fijar_perdida",
  proponer_fijar_saldo_favor_iva: "fijar_saldo_favor_iva",
  proponer_confirmar_apertura: "confirmar_apertura",
  proponer_firmar_conciliacion: "firmar_conciliacion",
};

/** ¿La salida de una herramienta `proponer_*` dejó una tarjeta puesta? */
export function quedoStaged(resultadoJson: string): boolean {
  try {
    return (JSON.parse(resultadoJson) as { staged?: boolean }).staged === true;
  } catch {
    return false;
  }
}
