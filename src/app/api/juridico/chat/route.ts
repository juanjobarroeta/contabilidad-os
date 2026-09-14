import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { MAX_BODY_BYTES, sanearHistorial } from "@/lib/ai/historial";
import { INSTANCIA, iniciarTurno, nuevoIdTurno, respuestaSse, respuestaSseDesdeAlmacen, turnoEnCurso, turnoReciente, type AlmacenTurnos } from "@/lib/juridico/turnos";
import { almacenPrisma } from "@/lib/juridico/turnos-almacen";
import { cargarContextoConversacion, correrTurnoAbogado } from "@/lib/juridico/turno-abogado";
import { asegurarConsumoJuridico } from "@/lib/juridico/consumo";
import { reportError } from "@/lib/observability";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/juridico/chat — el copiloto JURÍDICO (perfil abogado), en streaming.
//
// Mismo motor que el copiloto contable (tool-use en rondas, SSE, traza
// persistida) pero sin empresa, con todo el corpus y la jurisprudencia, y con
// el pase de verificación de citas SIEMPRE encendido. Cada llamada queda en
// CostEvent (subtipo ai.juridico) a nombre del usuario. El cuerpo del turno
// vive en src/lib/juridico/turno-abogado.ts.
//
// Body: { messages: [{role, content}], conversacionId?: string }
//
// El turno corre como tarea del proceso (src/lib/juridico/turnos.ts), se
// persiste en JuridicoTurno (eventos por lotes + checkpoint por ronda) y la
// respuesta es una vista reanudable: si el teléfono suspende el fetch o
// Railway corta el stream, GET ?conversacionId=&desde=N reproduce lo que
// falta. Si el contenedor muere, otro continúa el turno desde el checkpoint
// (turnos-reanudar.ts) y la vista lo sigue desde la base.
// El mensaje del usuario se guarda al arrancar; la respuesta al terminar (o lo
// que alcanzó a escribir, con meta.error, si el turno falla).
// Eventos SSE: turno | conversation | text | tool_start | tool_done | documento | documento_progreso | asunto | replace | done | error
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Un turno «en curso» en la base cuyo proceso late todavía (otro contenedor). */
const LATIDO_VIVO_MS = 45_000;
/** Un turno terminado se puede reproducir desde la base este tiempo más. */
const RETENCION_ALMACEN_MS = 10 * 60_000;

export async function POST(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const userId = usuario.id;
  if (!(await puedeUsarJuridico(userId))) return NextResponse.json({ error: "Tu cuenta no tiene acceso al copiloto jurídico" }, { status: 403 });

  // Tope del asiento: el jurídico no tiene empresa, así que la guardia por
  // empresa no aplica y sin esto corría sin techo (ver src/lib/juridico/consumo.ts).
  const puede = await asegurarConsumoJuridico(userId);
  if (!puede.permitido) return NextResponse.json({ error: puede.motivo, codigo: "JURIDICO_TOPE_MES", consumo: puede.consumo }, { status: 429 });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "La conversación es demasiado larga. Inicia una conversación nueva." }, { status: 413 });
  }
  let body: { messages?: unknown; conversacionId?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const messages = sanearHistorial(body.messages);
  if (!messages || messages.length === 0) return NextResponse.json({ error: "messages (texto) es requerido" }, { status: 400 });

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const nuevoMensajeUsuario = typeof lastUser?.content === "string" ? lastUser.content : "";

  // Conversación: la dada (del usuario) o una nueva titulada con el primer mensaje.
  let convId = typeof body.conversacionId === "string" ? body.conversacionId : null;
  let convCreada = false;
  if (convId) {
    const conv = await prisma.juridicoConversacion.findUnique({ where: { id: convId }, select: { userId: true, archivedAt: true } });
    if (!conv || conv.userId !== userId || conv.archivedAt) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  } else {
    const created = await prisma.juridicoConversacion.create({
      data: { userId, titulo: nuevoMensajeUsuario.trim().slice(0, 80) || "Nueva conversación" },
      select: { id: true },
    });
    convId = created.id;
    convCreada = true;
  }

  // Un turno a la vez por conversación: en este proceso o en otro que aún late.
  if (turnoEnCurso(convId)) return NextResponse.json({ error: "Ya hay una respuesta en curso en esta conversación; espera a que termine o vuelve a abrirla.", codigo: "TURNO_EN_CURSO" }, { status: 409 });
  const enOtroProceso = await almacenPrisma.ultimoDeConversacion(convId).catch(() => null);
  if (enOtroProceso?.estado === "en_curso" && Date.now() - enOtroProceso.latido.getTime() < LATIDO_VIVO_MS) {
    return NextResponse.json({ error: "Ya hay una respuesta en curso en esta conversación; espera a que termine o vuelve a abrirla.", codigo: "TURNO_EN_CURSO" }, { status: 409 });
  }

  const contexto = await cargarContextoConversacion(convId, userId);

  // El mensaje del usuario se guarda YA: si el turno muere, la conversación lo conserva.
  let mensajeUsuarioId: string | null = null;
  try {
    const mu = await prisma.juridicoMensaje.create({ data: { conversacionId: convId, rol: "user", contenido: nuevoMensajeUsuario }, select: { id: true } });
    mensajeUsuarioId = mu.id;
  } catch (e) {
    reportError(e, { ruta: "juridico/chat", paso: "persistir-usuario", conversacionId: convId });
  }

  // El turno también se guarda desde el arranque; si la base falla aquí, el
  // turno corre igual (sólo en memoria), como antes.
  const id = nuevoIdTurno();
  let almacen: AlmacenTurnos | undefined = almacenPrisma;
  try {
    await almacenPrisma.crear({ id, conversacionId: convId, userId, instancia: INSTANCIA, mensajeUsuarioId, pregunta: nuevoMensajeUsuario, convCreada, checkpoint: { mensajes: messages, rondas: 0, texto: "", fuentes: [], traza: null } });
  } catch (e) {
    reportError(e, { ruta: "juridico/chat", paso: "crear-turno", conversacionId: convId });
    almacen = undefined;
  }

  const turno = iniciarTurno({
    id,
    conversacionId: convId,
    userId,
    almacen,
    correr: (emitir) =>
      correrTurnoAbogado(
        {
          convId: convId!,
          userId,
          convCreada,
          mensajesIniciales: messages,
          pregunta: nuevoMensajeUsuario,
          mensajeUsuarioId,
          contexto,
          guardarCheckpoint: almacen ? (cp) => almacenPrisma.guardarCheckpoint(id, cp) : undefined,
        },
        emitir
      ),
  });
  return respuestaSse(turno);
}

// GET /api/juridico/chat?conversacionId=&desde=N — reanudar un turno: reproduce
// los eventos desde N y sigue en vivo. Si este proceso no lo tiene en memoria,
// lo lee de la base (corre en otro contenedor o está por reanudarse) y lo sigue
// por sondeo; 204 sólo si no hay turno reciente (el cliente entonces recarga la
// conversación).
export async function GET(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const url = new URL(req.url);
  const convId = url.searchParams.get("conversacionId") ?? "";
  const desde = Number(url.searchParams.get("desde") ?? "0") || 0;
  if (!convId) return NextResponse.json({ error: "conversacionId es requerido" }, { status: 400 });
  const turno = turnoReciente(convId);
  if (turno && turno.userId === usuario.id) return respuestaSse(turno, desde);
  const fila = await almacenPrisma.ultimoDeConversacion(convId).catch(() => null);
  if (!fila || fila.userId !== usuario.id) return new Response(null, { status: 204 });
  if (fila.estado !== "en_curso" && (!fila.terminadoAt || Date.now() - fila.terminadoAt.getTime() > RETENCION_ALMACEN_MS)) return new Response(null, { status: 204 });
  return respuestaSseDesdeAlmacen(almacenPrisma, fila.id, desde);
}
