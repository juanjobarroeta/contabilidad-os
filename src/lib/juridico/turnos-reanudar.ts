// ─────────────────────────────────────────────────────────────────────────────
// Reanudar turnos huérfanos: un turno «en curso» en la base cuyo proceso dejó
// de latir (redespliegue con la gracia agotada, crash) lo reclama este proceso
// y lo continúa desde su checkpoint. Corre al arrancar (instrumentation.ts) y
// cada 30 s; `reclamar` es atómico, así que dos contenedores no lo corren a la
// vez.
// ─────────────────────────────────────────────────────────────────────────────
import type Anthropic from "@anthropic-ai/sdk";
import { reportError } from "@/lib/observability";
import { INSTANCIA, elegirHuerfanos, iniciarTurno } from "./turnos";
import { almacenPrisma } from "./turnos-almacen";
import { cargarContextoConversacion, correrTurnoAbogado } from "./turno-abogado";

/** Sin latido este tiempo, el proceso que corría el turno se da por muerto. */
export const SIN_LATIDO_MS = 45_000;
const CADA_MS = 30_000;
const PRIMERA_MS = 10_000;

export async function reanudarHuerfanos(): Promise<number> {
  const filas = await almacenPrisma.huerfanos(SIN_LATIDO_MS);
  const candidatos = elegirHuerfanos(filas, Date.now(), SIN_LATIDO_MS);
  let reanudados = 0;
  for (const f of candidatos) {
    if (!(await almacenPrisma.reclamar(f.id, INSTANCIA, f.latido))) continue; // otro contenedor ganó
    try {
      const checkpoint = f.checkpoint;
      if (!checkpoint || !Array.isArray(checkpoint.mensajes) || checkpoint.mensajes.length === 0) {
        await almacenPrisma.terminar(f.id, "error", "Turno huérfano sin checkpoint; no se pudo continuar.");
        continue;
      }
      const contexto = await cargarContextoConversacion(f.conversacionId, f.userId);
      console.log(`[juridico/turnos] reanudando turno ${f.id} (conversación ${f.conversacionId}, ronda ${checkpoint.rondas}, ${f.eventos.length} eventos guardados)`);
      iniciarTurno({
        id: f.id,
        conversacionId: f.conversacionId,
        userId: f.userId,
        almacen: almacenPrisma,
        eventosPrevios: f.eventos,
        correr: (emitir) =>
          correrTurnoAbogado(
            {
              convId: f.conversacionId,
              userId: f.userId,
              convCreada: f.convCreada,
              mensajesIniciales: checkpoint.mensajes as Anthropic.MessageParam[],
              pregunta: f.pregunta,
              mensajeUsuarioId: f.mensajeUsuarioId,
              contexto,
              checkpoint,
              guardarCheckpoint: (cp) => almacenPrisma.guardarCheckpoint(f.id, cp),
            },
            emitir
          ),
      });
      reanudados++;
    } catch (e) {
      reportError(e, { ruta: "juridico/turnos", paso: "reanudar", turnoId: f.id, conversacionId: f.conversacionId });
      await almacenPrisma.terminar(f.id, "error", e instanceof Error ? e.message.slice(0, 500) : "No se pudo reanudar").catch(() => {});
    }
  }
  return reanudados;
}

let programado = false;

/** Al arrancar el servidor: un primer barrido a los 10 s y luego cada 30 s. */
export function programarReanudacion(): void {
  if (programado) return;
  programado = true;
  const tick = () =>
    reanudarHuerfanos()
      .then((n) => {
        if (n > 0) console.log(`[juridico/turnos] ${n} turno(s) reanudado(s) en ${INSTANCIA}`);
      })
      .catch((e) => reportError(e, { ruta: "juridico/turnos", paso: "barrido" }));
  setTimeout(tick, PRIMERA_MS).unref?.();
  setInterval(tick, CADA_MS).unref?.();
}
