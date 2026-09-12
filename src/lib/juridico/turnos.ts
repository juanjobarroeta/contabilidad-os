// ─────────────────────────────────────────────────────────────────────────────
// Turnos reanudables del copiloto jurídico.
//
// Un turno del abogado dura minutos (varias rondas de herramientas, un escrito
// entero). El teléfono suspende el fetch al bloquear la pantalla («Load
// failed»), Railway corta un stream a los 15 minutos, y un redespliegue mata
// el proceso. Por eso el turno NO vive en la conexión: corre aquí como tarea
// del proceso, guarda cada evento en un buffer, y la respuesta HTTP es sólo
// una VISTA que reproduce el buffer y se suscribe a lo que falta. Si el cliente
// se cae, vuelve con GET /api/juridico/chat?conversacionId= y sigue donde iba.
//
// Registro en memoria: el hub corre en una réplica. Tras un redespliegue el
// registro está vacío; el cliente entonces recarga la conversación, donde el
// turno anterior (que el contenedor viejo terminó en su gracia de 300 s) ya
// dejó sus mensajes.
// ─────────────────────────────────────────────────────────────────────────────

export type EventoTurno = Record<string, unknown> & { type: string };

export interface Turno {
  id: string;
  conversacionId: string;
  userId: string;
  inicio: number;
  estado: "en_curso" | "terminado" | "error";
  eventos: EventoTurno[];
  suscriptores: Set<(e: EventoTurno) => void>;
}

const RETENCION_MS = 10 * 60 * 1000; // un turno terminado se puede reproducir 10 min más
const turnos = new Map<string, Turno>(); // por conversación: un turno a la vez

export function turnoEnCurso(conversacionId: string): Turno | null {
  const t = turnos.get(conversacionId);
  return t && t.estado === "en_curso" ? t : null;
}

export function turnoReciente(conversacionId: string): Turno | null {
  return turnos.get(conversacionId) ?? null;
}

/**
 * Arranca un turno: `correr` recibe un `emitir` que guarda el evento y lo
 * reparte a los suscriptores. El turno se marca terminado cuando `correr`
 * resuelve (o en error si rechaza — `correr` debe emitir su propio evento
 * `error` antes de rechazar).
 */
export function iniciarTurno(args: { conversacionId: string; userId: string; correr: (emitir: (e: EventoTurno) => void) => Promise<void> }): Turno {
  const previo = turnos.get(args.conversacionId);
  if (previo?.estado === "en_curso") throw new Error("Ya hay un turno en curso en esta conversación; espera a que termine.");
  const turno: Turno = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, conversacionId: args.conversacionId, userId: args.userId, inicio: Date.now(), estado: "en_curso", eventos: [], suscriptores: new Set() };
  turnos.set(args.conversacionId, turno);
  const emitir = (e: EventoTurno) => {
    turno.eventos.push(e);
    for (const s of turno.suscriptores) {
      try {
        s(e);
      } catch {
        /* suscriptor muerto */
      }
    }
  };
  args
    .correr(emitir)
    .then(() => (turno.estado = "terminado"))
    .catch(() => (turno.estado = "error"))
    .finally(() => {
      for (const s of turno.suscriptores) {
        try {
          s({ type: "fin" });
        } catch {
          /* nada */
        }
      }
      turno.suscriptores.clear();
      setTimeout(() => {
        if (turnos.get(args.conversacionId) === turno) turnos.delete(args.conversacionId);
      }, RETENCION_MS).unref?.();
    });
  return turno;
}

/**
 * Una respuesta SSE que reproduce lo que el turno ya emitió y sigue con lo
 * nuevo; cierra cuando el turno termina. `desde` salta los primeros N eventos
 * (los que el cliente ya vio antes de caerse).
 */
export function respuestaSse(turno: Turno, desde = 0): Response {
  const encoder = new TextEncoder();
  const HEARTBEAT_MS = 10_000;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let suscriptor: ((e: EventoTurno) => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const enviar = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* cliente cerrado */
        }
      };
      const cerrar = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (suscriptor) turno.suscriptores.delete(suscriptor);
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      };
      const linea = (e: EventoTurno, i: number) => `id: ${i}\ndata: ${JSON.stringify(e)}\n\n`;
      enviar(`data: ${JSON.stringify({ type: "turno", id: turno.id, estado: turno.estado, eventos: turno.eventos.length })}\n\n`);
      for (let i = Math.max(0, desde); i < turno.eventos.length; i++) enviar(linea(turno.eventos[i], i));
      if (turno.estado !== "en_curso") {
        cerrar();
        return;
      }
      heartbeat = setInterval(() => enviar(": ping\n\n"), HEARTBEAT_MS);
      suscriptor = (e) => {
        if (e.type === "fin") cerrar();
        else enviar(linea(e, turno.eventos.length - 1));
      };
      turno.suscriptores.add(suscriptor);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (suscriptor) turno.suscriptores.delete(suscriptor);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
