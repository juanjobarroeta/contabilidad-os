import { hechosVigentes, MAX_HECHOS_PROMPT } from "./hechos";
import { MAX_NOTAS_PROMPT, notasRecientes, pendientesAbiertas } from "./notas";
import { bloqueExpedienteParaPrompt, type Expediente } from "./prompt";

// ─────────────────────────────────────────────────────────────────────────────
// El expediente, cargado. La contraparte impura de `prompt.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** Carga los tres pedazos en paralelo: son independientes entre sí. */
export async function cargarExpediente(companyId: string): Promise<Expediente> {
  const [hechos, pendientes, notas] = await Promise.all([
    hechosVigentes(companyId, MAX_HECHOS_PROMPT),
    pendientesAbiertas(companyId),
    notasRecientes(companyId, { limite: MAX_NOTAS_PROMPT }),
  ]);
  // Los pendientes ya salen arriba en su propia sección; repetirlos en «últimas
  // notas» gastaría tokens diciendo dos veces lo mismo.
  const ids = new Set(pendientes.map((p) => p.id));
  return { hechos, pendientes, notas: notas.filter((n) => !ids.has(n.id)) };
}

/**
 * El bloque del expediente listo para el system prompt.
 *
 * Va DESPUÉS del breakpoint de caché: el expediente cambia cuando el modelo
 * escribe en él dentro del mismo turno, y meterlo en el prefijo estable
 * invalidaría la caché de todo el prompt en cada anotación.
 */
export async function bloqueExpediente(companyId: string, hoy = new Date()): Promise<string> {
  return bloqueExpedienteParaPrompt(await cargarExpediente(companyId), hoy);
}
