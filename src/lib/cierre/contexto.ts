// ─────────────────────────────────────────────────────────────────────────────
// EL CIERRE, CONTADO AL MODELO. Bloque de prompt PURO (sin DB) con el estado
// de los doce pasos y, del paso activo, sus señales y las CIFRAS que los
// motores ya calcularon.
//
// Por qué existe: sin esto el copiloto sólo recibía un texto sembrado desde la
// página y contestaba de memoria — llegó a pedirle al contador el coeficiente
// de utilidad «de tu declaración anual» cuando `computeTaxPosition` ya lo
// deduce de la anual que tenemos guardada. Las cifras van EN el prompt para
// que no haya forma de preguntar lo que el sistema tiene.
// ─────────────────────────────────────────────────────────────────────────────

import type { CierreEvaluado, PasoConDecision } from "./evaluar";
import type { ClavePasoCierre } from "./claves";
import { PASOS } from "./workflow";

export interface ContextoCierre {
  year: number;
  month: number;
  paso?: ClavePasoCierre;
}

const ESTADO_TXT: Record<string, string> = {
  listo: "listo",
  atencion: "necesita atención",
  bloquea: "BLOQUEA el cierre",
  espera: "esperando a un paso anterior",
  no_aplica: "no aplica",
  sin_datos: "sin datos todavía",
};

const DECISION_TXT: Record<string, string> = {
  PENDIENTE: "sin confirmar",
  CONFIRMADO: "confirmado por el contador",
  OMITIDO: "omitido con motivo",
  REVISAR: "confirmado antes, pero la evidencia CAMBIÓ: hay que revisarlo de nuevo",
};

/** Redacta un valor para el prompt: montos con dos decimales, null explícito. */
function val(v: unknown): string {
  if (v == null) return "no disponible";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(v < 1 && v > -1 ? 4 : 2);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function lineasCifras(cifras: Record<string, unknown>, sangria = "  "): string[] {
  return Object.entries(cifras).map(([k, v]) => `${sangria}- ${k}: ${val(v)}`);
}

/**
 * Bloque de sistema con el cierre del periodo. Va DESPUÉS del breakpoint de
 * caché (cambia con cada paso). PURO.
 */
export function bloqueCierre(cierre: CierreEvaluado, activo: PasoConDecision | null, periodoLabel: string): string {
  const partes: string[] = [];
  partes.push(`\n\n## Cierre guiado · ${periodoLabel}`);
  partes.push(
    `El contador está cerrando el periodo ${cierre.periodo} de esta empresa en la pantalla /cierre. ` +
      `Estado canónico: ${cierre.estado.fase}. ` +
      `Van ${cierre.resumen.confirmados} de ${cierre.resumen.aplican} pasos confirmados` +
      (cierre.estado.bloqueos.length > 0 ? `; ${cierre.estado.bloqueos.length} bloqueo(s) duro(s).` : ".")
  );

  partes.push("\n### Los pasos y su estado (lo que dice el sistema HOY)");
  for (const p of cierre.pasos) {
    if (p.estadoCalculado === "no_aplica") continue;
    const marca = p.clave === activo?.clave ? " ← PASO ACTIVO" : "";
    partes.push(
      `${String(p.orden + 1).padStart(2, "0")}. ${p.titulo} — ${ESTADO_TXT[p.estadoCalculado] ?? p.estadoCalculado}, ${DECISION_TXT[p.estado] ?? p.estado}` +
        (p.detalle ? `: ${p.detalle}` : "") +
        marca
    );
  }

  if (activo) {
    partes.push(`\n### Paso activo: ${activo.titulo}`);
    partes.push(activo.descripcion);
    if (activo.fechaLimite) {
      partes.push(
        (activo.diasRestantes ?? 0) < 0
          ? `Fecha límite ${activo.fechaLimite}: VENCIDA hace ${Math.abs(activo.diasRestantes ?? 0)} día(s).`
          : `Fecha límite ${activo.fechaLimite} — quedan ${activo.diasRestantes} día(s).`
      );
    }
    const senales = activo.senales.filter((s) => s.estado !== "na");
    if (senales.length > 0) {
      partes.push("\nSeñales del paso (cada una la calculó un motor, no tu memoria):");
      for (const s of senales) {
        partes.push(`- [${s.estado.toUpperCase()}] ${s.resumen}`);
      }
    }
    const def = PASOS.find((p) => p.clave === activo.clave);
    if (def && def.revisar.length > 0) {
      partes.push("\nQué se revisa en este paso (compruébalo tú, no lo des por hecho):");
      for (const r of def.revisar) partes.push(`- ${r}`);
      partes.push(
        `Suele empezarse por: ${def.tools.filter((t) => !t.startsWith("proponer_")).join(", ")}. ` +
          "Es una pista, no un límite: tienes TODAS tus herramientas y datos de la empresa (facturas, bancos, nómina, declaraciones, hallazgos, la ley) — si algo del paso se aclara mirando otra cosa, míralo."
      );
    }
    const cifras = activo.cifras ?? {};
    if (Object.keys(cifras).length > 0) {
      partes.push("\nCifras YA CALCULADAS para este paso — úsalas tal cual, NUNCA las pidas ni las recalcules:");
      partes.push(...lineasCifras(cifras));
    }
  }

  partes.push(`
### Cómo trabajas el cierre
- Las cifras de arriba y las de las tools son las buenas. **Nunca le pidas al contador un dato que ya aparece aquí** (coeficiente, saldo a favor, IVA, ISR, fechas): si está, dilo y explica de dónde sale.
- Si una cifra falta de verdad, dilo con precisión: qué falta, por qué no se puede calcular y dónde se captura.
- **Un cero capturado y un cero por falta de dato NO son lo mismo.** Cuando una cifra traiga su procedencia (\`fuente\`), úsala: \`sin-dato\` significa que NADIE lo revisó — dilo así («el saldo a favor inicial no está capturado; hoy se toma como cero»), nunca «el saldo a favor es $0». Con \`acuse\`, \`manual\` o \`calculado\`, di de dónde salió.
- No hagas aritmética propia: los números salen de los motores. Puedes explicarlos, compararlos y ordenarlos.
- Para cerrar un paso propón \`proponer_confirmar_paso\`; el contador toca Confirmar. Nunca digas que un paso quedó confirmado si no lo confirmó él.
- **No pidas permiso para proponer.** Si de tu análisis sale que el paso está listo o que un dato debe fijarse, llama la herramienta en ese mismo turno y deja la tarjeta puesta; el contador decide en el botón Confirmar. Nada de «¿te dejo la tarjeta?» o «¿la preparo?» — eso es un viaje de ida y vuelta para nada.
- **Cuando algo se pueda capturar desde aquí, ofrécelo con su tarjeta en vez de mandar al contador a otra pantalla.** Coeficiente → \`proponer_fijar_coeficiente\`; pérdidas por amortizar → \`proponer_fijar_perdida\`; saldo a favor de IVA inicial → \`proponer_fijar_saldo_favor_iva\`; punto de partida revisado → \`proponer_confirmar_apertura\`; **cuentas sin código agrupador del SAT → \`query_cuentas_sin_agrupador\` y luego \`proponer_fijar_agrupador\` cuenta por cuenta**. Sólo mándalo a otra pantalla cuando de verdad no exista una propuesta para eso.
- **Un dato sin capturar es TRABAJO TUYO, no una tarea que le pasas al contador.** Antes de decir «captura la pérdida fiscal» o «revísalo en la declaración», ve a buscarlo: la anual del ejercicio anterior viene en las cifras del paso (\`declaracionAnualAnterior\`) y \`query_tax_declarations\` te devuelve lo que cada declaración guardada reporta, campo por campo. Luego di qué encontraste y deja la tarjeta con el valor. Si la anual existe y no reporta pérdida, eso también es una respuesta: propón capturar **0** diciendo que lo revisaste (un cero revisado sí vale; el que nadie miró, no). Sólo pídele el dato al contador cuando el sistema de verdad no lo tenga, y entonces di exactamente qué falta.
- **El conteo de una señal nunca es el final del camino.** «N cuentas sin código agrupador» dice cuántas, no cuáles: llama \`query_cuentas_sin_agrupador\` y NÓMBRALAS, con su tipo y la baraja de códigos del Anexo 24 que trae cada una. Pedirle al contador que te copie los nombres de otra pantalla es hacerle a él tu trabajo. Los códigos que propongas salen SIEMPRE de esa baraja: el Anexo 24 es una lista cerrada y uno inventado hace que el SAT rechace la contabilidad electrónica. Y si una cuenta viene marcada \`naceDeLaBalanza\`, dilo: esa cuenta nunca estuvo en un catálogo presentado —la creó la balanza del SAT—, así que no hay declaración previa de la que sacar su agrupador.
- Ve al grano: qué falta, en qué orden y cuál es el siguiente movimiento. Sin repetir la lista de pasos completa salvo que te la pidan.
- **Nunca digas que no tienes acceso a algo sin haberlo intentado.** Dentro del cierre conservas todas tus herramientas: declaraciones presentadas y sus acuses, facturas, movimientos bancarios, nómina, complementos, hallazgos y la ley. Si el contador pregunta por un saldo, un mes anterior o un dato de otra área, ve a buscarlo.`);

  return partes.join("\n");
}
