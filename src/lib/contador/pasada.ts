import Anthropic from "@anthropic-ai/sdk";
import { tools } from "@/lib/ai/tools";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { meteredCreate } from "@/lib/costos/anthropic";
import { prisma } from "@/lib/prisma";
import { estadoIAEmpresa } from "@/lib/ai/guardia";
import { fechaLocalMx } from "@/lib/notificaciones";
import { effectiveCierrePlan } from "@/lib/planes";
import { anotar, pendientesAbiertas } from "@/lib/expediente/notas";
import { bloqueExpediente } from "@/lib/expediente/cargar";
import { solicitudesAbiertas } from "@/lib/solicitudes/registro";
import { tituloDeTipo } from "@/lib/solicitudes/claves";
import { saludActual } from "@/lib/salud/snapshot";
import { cadenciaDePlan, tocaHoy, type ResumenCorrida } from "./claves";
import { ejecutarHerramientaPasada } from "./ejecutar";
import { NOMBRE_CIERRE, NOMBRES_PASADA, toolsPasada } from "./herramientas";
import { mensajeDePasada, normalizarResumen, promptDelContador, resumenEnTexto } from "./prompt";

// ─────────────────────────────────────────────────────────────────────────────
// LA PASADA DEL CONTADOR — la revisión que nadie pidió.
//
// Es lo caro del sistema, y por eso es lo último que se construyó: todo lo
// anterior existe para que esta pasada sea barata y valga la pena.
//
//   · F2 dice A QUIÉN mirar. Sin ese filtro, razonar toda la cartera todos los
//     días cuesta lo que no vale, porque la mayoría amaneció igual que ayer.
//   · F1 dice QUÉ YA SE SABE, para que no vuelva a descubrir lo mismo cada
//     mañana ni repita un compromiso ya abierto.
//   · F0 dice POR QUÉ los motores decidieron lo que decidieron, para que pueda
//     juzgar una conciliación en vez de creerle.
//   · F4 le da dónde PEDIR lo que falta, en vez de reportarlo otra vez.
//
// El prefijo del prompt va cacheado; el expediente y el trabajo del día, no.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

const MODELO = process.env.AI_CONTADOR_MODEL ?? process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const MAX_RONDAS = 10;
const MAX_TOKENS = 2048;

/** Herramientas de la pasada: las del copiloto más las suyas propias. */
const TOOLS_PASADA: Anthropic.Tool[] = [...tools, ...toolsPasada];

export interface ResultadoPasada {
  companyId: string;
  corrio: boolean;
  motivo?: string;
  resumen?: ResumenCorrida;
  rondas?: number;
  notaId?: string;
}

const dias = (desde: Date, hoy: Date) => Math.max(0, Math.floor((hoy.getTime() - desde.getTime()) / 86_400_000));

/**
 * Corre UNA pasada. Devuelve `corrio: false` con su motivo en vez de lanzar:
 * en una corrida de cartera, que una empresa no aplique es normal y no debe
 * parecerse a un error.
 */
export async function correrPasadaEmpresa(companyId: string, hoy = new Date()): Promise<ResultadoPasada> {
  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { razonSocial: true, rfc: true, regimenFiscal: true, isActive: true },
  });
  if (!empresa || !empresa.isActive) return { companyId, corrio: false, motivo: "empresa inactiva" };

  // El presupuesto se mira ANTES de invocar el modelo. Una pasada automática
  // nunca debe ser lo que vacía el tope del cliente: quien paga por el copiloto
  // es él, y quedarse sin chat porque un cron gastó su mes es indefendible.
  const estado = await estadoIAEmpresa(companyId);
  if (estado && estado.gastoMesUsd >= estado.topeMesUsd) {
    return { companyId, corrio: false, motivo: "sin presupuesto de IA este mes" };
  }

  const salud = await saludActual(companyId);
  if (!salud) return { companyId, corrio: false, motivo: "sin foto de salud todavía" };

  const [pendientes, solicitudes, bloqueExp] = await Promise.all([
    pendientesAbiertas(companyId),
    solicitudesAbiertas(companyId),
    bloqueExpediente(companyId, hoy),
  ]);

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: promptDelContador(empresa, hoy), cache_control: { type: "ephemeral" } },
  ];
  // El expediente va DESPUÉS del breakpoint: el modelo lo escribe dentro de la
  // propia pasada, y meterlo en el prefijo invalidaría la caché en cada nota.
  if (bloqueExp.trim()) system.push({ type: "text", text: bloqueExp });

  const mensaje = mensajeDePasada({
    dia: salud.dia,
    dimensiones: salud.dimensiones,
    deltas: salud.deltas,
    pendientes: pendientes.map((p) => ({
      titulo: p.titulo,
      cuerpo: p.cuerpo,
      desdeDias: dias(p.createdAt, hoy),
    })),
    solicitudes: solicitudes.map((s) => ({
      titulo: tituloDeTipo(s.tipo),
      periodo: s.periodo,
      desdeDias: dias(s.createdAt, hoy),
    })),
  });

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: mensaje }];
  let resumen: ResumenCorrida | null = null;
  let rondas = 0;

  while (rondas < MAX_RONDAS && !resumen) {
    const res = await meteredCreate(
      anthropic,
      { companyId, userId: null, subtipo: "contador.pasada" },
      { model: MODELO, max_tokens: MAX_TOKENS, system, tools: TOOLS_PASADA, messages },
    );

    const usos = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (usos.length === 0) break; // se quedó sin llamar a cerrar_pasada

    const resultados: Anthropic.ToolResultBlockParam[] = [];
    for (const u of usos) {
      if (u.name === NOMBRE_CIERRE) {
        resumen = normalizarResumen(u.input);
        resultados.push({ type: "tool_result", tool_use_id: u.id, content: "Pasada cerrada." });
        continue;
      }
      let salida: string;
      try {
        salida = NOMBRES_PASADA.has(u.name)
          ? await ejecutarHerramientaPasada(u.name, u.input as Record<string, unknown>, companyId)
          : await executeToolCall(u.name, u.input as Record<string, unknown>, companyId, { inApp: false });
      } catch (e) {
        // Una herramienta que falla no tumba la pasada: el modelo lo ve y sigue
        // con lo demás, igual que un contador al que se le cae un reporte.
        salida = `Error al ejecutar ${u.name}: ${e instanceof Error ? e.message : "desconocido"}`;
      }
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: salida });
    }

    messages = [...messages, { role: "assistant", content: res.content }, { role: "user", content: resultados }];
    rondas++;
  }

  if (!resumen) {
    // Se acabaron las rondas sin cierre. Se deja constancia: una pasada que se
    // pagó y no dejó nada escrito es invisible, y lo invisible no se arregla.
    const nota = await anotar({
      companyId,
      autor: "agente",
      tipo: "observacion",
      tema: "general",
      titulo: `Pasada del ${salud.dia} sin cerrar`,
      cuerpo: `La pasada agotó las ${MAX_RONDAS} rondas sin llamar a cerrar_pasada. Queda sin resumen.`,
    });
    return { companyId, corrio: true, rondas, notaId: nota.id, motivo: "sin cierre" };
  }

  const nota = await anotar({
    companyId,
    autor: "agente",
    tipo: "resumen_corrida",
    tema: "general",
    titulo: resumen.sinNovedad
      ? `Pasada del ${salud.dia}: sin novedad`
      : `Pasada del ${salud.dia}: ${resumen.renglones.length} ${resumen.renglones.length === 1 ? "punto" : "puntos"}`,
    cuerpo: resumenEnTexto(resumen),
    refs: resumen.renglones.flatMap((r) => r.evidencia),
    // El cuerpo es para que lo lea una persona; esto es lo que pinta el rail.
    // Sin ello el rail tendría que parsear prosa para saber qué se atendió.
    datos: resumen as unknown as Parameters<typeof anotar>[0]["datos"],
  });

  return { companyId, corrio: true, resumen, rondas, notaId: nota.id };
}

export interface ResultadoPasadaDiaria {
  dia: string;
  candidatas: number;
  corridas: number;
  omitidas: number;
  errores: number;
  resultados: ResultadoPasada[];
}

/**
 * Corre la pasada para las empresas que la merecen hoy.
 *
 * El filtro es lo que hace viable la cartera: sólo entran las que F2 marcó
 * (cambiaron a peor o están bloqueadas) o las que arrastran un compromiso
 * abierto. Una empresa que amaneció igual de bien que ayer no se razona.
 */
export async function correrPasadaDiaria(
  opts: { hoy?: Date; force?: boolean; companyId?: string; max?: number } = {},
): Promise<ResultadoPasadaDiaria> {
  const hoy = opts.hoy ?? new Date();
  const dia = fechaLocalMx(hoy);
  const max = opts.max ?? 25;

  const empresas = await prisma.company.findMany({
    where: { isActive: true, ...(opts.companyId ? { id: opts.companyId } : {}) },
    select: { id: true, tier: true, despacho: { select: { defaultTier: true } } },
    orderBy: { createdAt: "asc" },
  });

  const r: ResultadoPasadaDiaria = { dia, candidatas: 0, corridas: 0, omitidas: 0, errores: 0, resultados: [] };
  if (empresas.length === 0) return r;

  const ids = empresas.map((e) => e.id);
  const [snapshots, conPendientes, yaCorridas] = await Promise.all([
    prisma.saludSnapshot.findMany({
      where: { dia, companyId: { in: ids } },
      select: { companyId: true, requiereAtencion: true },
    }),
    prisma.expedienteNota.groupBy({
      by: ["companyId"],
      where: { companyId: { in: ids }, tipo: "pendiente", estado: "abierta" },
      _count: { _all: true },
    }),
    // Una por empresa y día: la nota del resumen ES el candado, sin columna nueva.
    prisma.expedienteNota.findMany({
      where: { companyId: { in: ids }, tipo: "resumen_corrida", createdAt: { gte: inicioDelDia(hoy) } },
      select: { companyId: true },
    }),
  ]);

  const atencion = new Map(snapshots.map((s) => [s.companyId, s.requiereAtencion]));
  const pendientes = new Set(conPendientes.map((p) => p.companyId));
  const hechas = new Set(yaCorridas.map((n) => n.companyId));

  for (const e of empresas) {
    if (r.corridas >= max) break;
    const cadencia = cadenciaDePlan(effectiveCierrePlan(e));
    const merece = atencion.get(e.id) === true || pendientes.has(e.id);
    if (!opts.force && (!tocaHoy(cadencia, hoy) || !merece || hechas.has(e.id))) {
      r.omitidas++;
      continue;
    }
    r.candidatas++;
    try {
      const res = await correrPasadaEmpresa(e.id, hoy);
      if (res.corrio) r.corridas++;
      else r.omitidas++;
      r.resultados.push(res);
    } catch (err) {
      r.errores++;
      console.error("[contador] pasada falló:", e.id, err instanceof Error ? err.message : err);
      r.resultados.push({ companyId: e.id, corrio: false, motivo: err instanceof Error ? err.message : "error" });
    }
  }
  return r;
}

/** Medianoche de México del día de `hoy`, para acotar «ya corrió hoy». */
function inicioDelDia(hoy: Date): Date {
  return new Date(`${fechaLocalMx(hoy)}T00:00:00-06:00`);
}
