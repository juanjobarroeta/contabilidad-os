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
import type { CierreEvaluado, PasoConDecision } from "./evaluar";
import { LLANO } from "./lenguaje";

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

// ── La cola de acciones: qué toca AHORA ──────────────────────────────────────
//
// La pantalla mostraba doce pasos, cada uno con su prosa, y el contador tenía
// que deducir cuál era el siguiente movimiento. Esto aplana el cierre a una
// LISTA DE ACCIONES en orden: la primera es la de la pantalla, el resto es «lo
// que sigue». Pura: se calcula igual en el servidor y en el navegador.

export interface AccionCierre {
  /** Clave de la señal que la genera (única dentro del periodo). */
  clave: string;
  paso: ClavePasoCierre;
  pasoTitulo: string;
  pasoOrden: number;
  /** Qué hacer, en llano. */
  hacer: string;
  /** Qué es y por qué importa, en llano. */
  que: string;
  /** El dato exacto del motor (con su número). */
  dato: string;
  urgencia: "bloquea" | "atencion";
  cta?: { label: string; href: string };
  /** Herramienta `proponer_*` que puede resolverla desde el chat, si existe. */
  tool?: string;
  fechaLimite?: string;
  diasRestantes?: number;
}

/** Qué herramienta resuelve cada señal (la tabla de arriba, del revés). */
function toolDeSenal(paso: PasoConDecision, senal: string): string | undefined {
  const reglas = CANDIDATAS[paso.clave];
  return reglas?.find((r) => r.senal === senal)?.tools[0];
}

/**
 * Todo lo que falta en el periodo, en el orden en que conviene atacarlo:
 * por paso (el flujo ya está ordenado por dependencias) y, dentro del paso,
 * lo que bloquea antes de lo que sólo pide atención.
 *
 * Se excluyen los pasos que NO APLICAN, los que ya decidió el humano y los que
 * están EN ESPERA (su bloqueo vive en un paso anterior: pedir acción ahí sería
 * mandar a empujar una puerta cerrada).
 */
export function accionesDelCierre(cierre: CierreEvaluado): AccionCierre[] {
  const out: AccionCierre[] = [];
  for (const paso of cierre.pasos) {
    if (paso.estadoCalculado === "no_aplica" || paso.estadoCalculado === "espera") continue;
    if (paso.estado === "CONFIRMADO" || paso.estado === "OMITIDO") continue;
    const vivas = paso.senales.filter((s) => s.estado === "error" || s.estado === "warn");
    for (const s of vivas.sort((a, b) => (a.estado === b.estado ? 0 : a.estado === "error" ? -1 : 1))) {
      const llano = LLANO[s.clave];
      out.push({
        clave: s.clave,
        paso: paso.clave,
        pasoTitulo: paso.titulo,
        pasoOrden: paso.orden,
        hacer: llano?.hacer ?? s.resumen,
        que: llano?.que ?? "",
        dato: s.resumen,
        urgencia: s.estado === "error" ? "bloquea" : "atencion",
        cta: s.cta,
        tool: toolDeSenal(paso, s.clave),
        fechaLimite: paso.fechaLimite,
        diasRestantes: paso.diasRestantes,
      });
    }
  }
  return out;
}

/**
 * Pasos que aplican y ya no piden nada: sirven para el avance honesto («3 de 9
 * listos») sin contar los que no aplican a la empresa.
 */
export function avanceDelCierre(cierre: CierreEvaluado): { listos: number; total: number } {
  const aplican = cierre.pasos.filter((p) => p.estadoCalculado !== "no_aplica");
  const listos = aplican.filter(
    (p) => p.estado === "CONFIRMADO" || p.estado === "OMITIDO" || p.estadoCalculado === "listo"
  );
  return { listos: listos.length, total: aplican.length };
}
