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
// Y tampoco vive sólo en la memoria del proceso: cada evento se guarda por
// lotes en la base (JuridicoTurno) junto con un CHECKPOINT por ronda de
// herramientas. Si el contenedor muere a media respuesta (redespliegue con la
// gracia agotada, crash), otro contenedor encuentra el turno sin latido, lo
// reclama y lo continúa desde el checkpoint (src/lib/juridico/turnos-reanudar.ts).
// La vista GET, si no encuentra el turno en memoria, lo reproduce desde la
// base y sigue en vivo por sondeo.
// ─────────────────────────────────────────────────────────────────────────────

import { reportError } from "@/lib/observability";

export type EventoTurno = Record<string, unknown> & { type: string };

export type EstadoTurno = "en_curso" | "terminado" | "error";

/** Lo que hace falta para continuar un turno en otro proceso. */
export interface CheckpointTurno {
  mensajes: unknown[];
  rondas: number;
  texto: string;
  fuentes: { cita: string; texto: string }[];
  traza: unknown;
}

/** Persistencia del turno (Prisma en producción, memoria en tests). */
export interface AlmacenTurnos {
  crear(t: { id: string; conversacionId: string; userId: string; instancia: string; mensajeUsuarioId: string | null; pregunta: string; convCreada: boolean; checkpoint: CheckpointTurno }): Promise<void>;
  agregarEventos(id: string, eventos: EventoTurno[]): Promise<void>;
  latido(id: string): Promise<void>;
  guardarCheckpoint(id: string, checkpoint: CheckpointTurno): Promise<void>;
  terminar(id: string, estado: Exclude<EstadoTurno, "en_curso">, error?: string | null): Promise<void>;
}

/** Lo que la vista por sondeo necesita leer. */
export interface LectorTurnos {
  leer(id: string): Promise<{ estado: EstadoTurno; eventos: EventoTurno[] } | null>;
}

export interface Turno {
  id: string;
  conversacionId: string;
  userId: string;
  inicio: number;
  estado: EstadoTurno;
  eventos: EventoTurno[];
  suscriptores: Set<(e: EventoTurno) => void>;
}

const RETENCION_MS = 10 * 60 * 1000; // un turno terminado se puede reproducir 10 min más
const LOTE_MS = 800; // los deltas de texto se guardan por lotes; herramientas y fin, al momento
const LATIDO_MS = 15_000;
const turnos = new Map<string, Turno>(); // por conversación: un turno a la vez

/** Identidad de este proceso: quien reclama un turno huérfano y quien late. */
export const INSTANCIA = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "local"}-${Date.now().toString(36)}`;

export function nuevoIdTurno(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
 *
 * Con `almacen`, los eventos se persisten por lotes, el turno late cada 15 s y
 * al final se marca terminado/error en la base. `eventosPrevios` es lo que ya
 * estaba guardado cuando se reanuda un turno en otro proceso: se precarga para
 * que los índices que usa el cliente (`desde=N`) sigan valiendo.
 */
export function iniciarTurno(args: {
  id?: string;
  conversacionId: string;
  userId: string;
  correr: (emitir: (e: EventoTurno) => void) => Promise<void>;
  almacen?: AlmacenTurnos;
  eventosPrevios?: EventoTurno[];
}): Turno {
  const previo = turnos.get(args.conversacionId);
  if (previo?.estado === "en_curso") throw new Error("Ya hay un turno en curso en esta conversación; espera a que termine.");
  const turno: Turno = {
    id: args.id ?? nuevoIdTurno(),
    conversacionId: args.conversacionId,
    userId: args.userId,
    inicio: Date.now(),
    estado: "en_curso",
    eventos: [...(args.eventosPrevios ?? [])],
    suscriptores: new Set(),
  };
  turnos.set(args.conversacionId, turno);

  // Persistencia por lotes: una cadena de escrituras en orden, nunca dos a la vez.
  const almacen = args.almacen;
  let pendientes: EventoTurno[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cadena: Promise<void> = Promise.resolve();
  const vaciar = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!almacen || pendientes.length === 0) return;
    const lote = pendientes;
    pendientes = [];
    cadena = cadena.then(() => almacen.agregarEventos(turno.id, lote)).catch((e) => reportError(e, { ruta: "juridico/turnos", paso: "guardar-eventos", turnoId: turno.id }));
  };
  const latido = almacen ? setInterval(() => void almacen.latido(turno.id).catch(() => {}), LATIDO_MS) : null;
  latido?.unref?.();

  const emitir = (e: EventoTurno) => {
    turno.eventos.push(e);
    for (const s of turno.suscriptores) {
      try {
        s(e);
      } catch {
        /* suscriptor muerto */
      }
    }
    if (!almacen) return;
    pendientes.push(e);
    if (e.type === "text") {
      if (!timer) timer = setTimeout(vaciar, LOTE_MS);
    } else {
      vaciar();
    }
  };

  let errorFinal: string | null = null;
  args
    .correr(emitir)
    .then(() => (turno.estado = "terminado"))
    .catch((err) => {
      turno.estado = "error";
      errorFinal = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    })
    .finally(async () => {
      for (const s of turno.suscriptores) {
        try {
          s({ type: "fin" });
        } catch {
          /* nada */
        }
      }
      turno.suscriptores.clear();
      if (latido) clearInterval(latido);
      if (almacen) {
        vaciar();
        await cadena;
        await almacen.terminar(turno.id, turno.estado === "error" ? "error" : "terminado", errorFinal).catch((e) => reportError(e, { ruta: "juridico/turnos", paso: "terminar", turnoId: turno.id }));
      }
      setTimeout(() => {
        if (turnos.get(args.conversacionId) === turno) turnos.delete(args.conversacionId);
      }, RETENCION_MS).unref?.();
    });
  return turno;
}

const CABECERAS_SSE = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" };

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
  return new Response(stream, { headers: CABECERAS_SSE });
}

/**
 * La misma vista, pero leyendo el turno de la base: para cuando este proceso
 * no lo tiene en memoria (corre en otro contenedor, o está esperando a que
 * alguien lo reanude). Sondea cada `intervaloMs` hasta que termine o venza
 * `maximoMs`.
 */
export function respuestaSseDesdeAlmacen(lector: LectorTurnos, id: string, desde = 0, opts: { intervaloMs?: number; maximoMs?: number } = {}): Response {
  const encoder = new TextEncoder();
  const intervalo = opts.intervaloMs ?? 1_000;
  const maximo = opts.maximoMs ?? 15 * 60_000;
  let cancelado = false;
  const stream = new ReadableStream({
    async start(controller) {
      const enviar = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cancelado = true;
        }
      };
      const linea = (e: EventoTurno, i: number) => `id: ${i}\ndata: ${JSON.stringify(e)}\n\n`;
      let vistos = Math.max(0, desde);
      const limite = Date.now() + maximo;
      let primera = true;
      let ping = 0;
      try {
        while (!cancelado && Date.now() < limite) {
          const fila = await lector.leer(id);
          if (!fila) break;
          if (primera) {
            enviar(`data: ${JSON.stringify({ type: "turno", id, estado: fila.estado, eventos: fila.eventos.length, origen: "almacen" })}\n\n`);
            primera = false;
          }
          for (; vistos < fila.eventos.length; vistos++) enviar(linea(fila.eventos[vistos], vistos));
          if (fila.estado !== "en_curso") break;
          if (++ping % 10 === 0) enviar(": ping\n\n");
          await new Promise((r) => setTimeout(r, intervalo));
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      }
    },
    cancel() {
      cancelado = true;
    },
  });
  return new Response(stream, { headers: CABECERAS_SSE });
}

/**
 * De los turnos «en curso» de la base, los que nadie late: el proceso que los
 * corría murió. Puro; la decisión de reclamarlos y correrlos es de
 * turnos-reanudar.ts.
 */
export function elegirHuerfanos<T extends { id: string; conversacionId: string; latido: Date; instancia: string }>(filas: T[], ahora: number, msSinLatido: number): T[] {
  return filas.filter((f) => f.instancia !== INSTANCIA && ahora - f.latido.getTime() > msSinLatido && !turnoEnCurso(f.conversacionId));
}
