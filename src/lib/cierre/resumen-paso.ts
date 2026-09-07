// ─────────────────────────────────────────────────────────────────────────────
// LA APERTURA DEL PASO — lo primero que el contador lee al abrirlo, escrito por
// el copiloto CON las cifras que los motores ya calcularon.
//
// Cacheada por el hash de la evidencia: se regenera sólo cuando los datos del
// paso cambian, no en cada visita (abrir doce pasos de veintidós empresas no
// puede costar doce llamadas al modelo por empresa y día).
//
// Regla dura: el modelo REDACTA, no calcula. Recibe las señales y las cifras
// hechas; si una cifra falta, dice qué falta y dónde se captura — nunca se la
// pide al contador cuando el sistema la tiene.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { meteredCreate } from "../costos/anthropic";
import { asegurarUsoIA } from "../ai/guardia";
import { evaluarCierre, type PasoConDecision } from "./evaluar";
import { conversacionDelPeriodo } from "./pase-diario";
import { etiquetaPeriodo } from "./plantillas";
import type { ClavePasoCierre } from "./claves";

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY del entorno
const MODELO = process.env.AI_CIERRE_MODEL ?? process.env.AI_CHAT_MODEL ?? "claude-fable-5";

export interface AperturaPaso {
  texto: string;
  /** true = venía cacheada (no costó tokens). */
  cacheada: boolean;
  /** Id del mensaje en el hilo del cierre (null si no se pudo anclar). */
  mensajeId?: string | null;
}

/**
 * Deja la apertura en el hilo del periodo, UNA vez por (paso, evidencia): al
 * volver a la pantalla el mensaje ya está en la conversación y no se repite.
 * Si la evidencia cambió, la apertura nueva se agrega — el hilo muestra qué
 * pasó.
 */
async function anclarEnElHilo(args: {
  companyId: string;
  year: number;
  month: number;
  clave: ClavePasoCierre;
  hash: string;
  texto: string;
  responsableUserId: string | null;
}): Promise<string | null> {
  const { companyId, year, month, clave, hash, texto, responsableUserId } = args;
  try {
    const conversationId = await conversacionDelPeriodo(companyId, year, month, responsableUserId);
    if (!conversationId) return null;
    const ya = await prisma.chatMessage.findFirst({
      where: {
        conversationId,
        AND: [
          { meta: { path: ["cierre", "paso"], equals: clave } },
          { meta: { path: ["cierre", "hash"], equals: hash } },
        ],
      },
      select: { id: true },
    });
    if (ya) return ya.id;
    const creado = await prisma.chatMessage.create({
      data: {
        conversationId,
        role: "assistant",
        authorId: null,
        content: texto,
        meta: { origen: "apertura", cierre: { paso: clave, hash } } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return creado.id;
  } catch (e) {
    console.error("[cierre/resumen] no se pudo anclar la apertura:", companyId, clave, e instanceof Error ? e.message : e);
    return null;
  }
}

function prompt(paso: PasoConDecision, periodoLabel: string, empresa: string): string {
  const senales = paso.senales
    .filter((s) => s.estado !== "na")
    .map((s) => `- [${s.estado}] ${s.resumen}`)
    .join("\n");
  const cifras = Object.entries(paso.cifras ?? {})
    .map(([k, v]) => `- ${k}: ${v == null ? "no disponible" : JSON.stringify(v)}`)
    .join("\n");

  return `Empresa: ${empresa}. Cierre de ${periodoLabel}. Paso «${paso.titulo}» (${paso.estadoCalculado}).
${paso.descripcion}

Señales que calcularon los motores:
${senales || "- (sin señales)"}

Cifras YA CALCULADAS para este paso:
${cifras || "- (este paso no tiene cifras)"}
${paso.fechaLimite ? `\nFecha límite: ${paso.fechaLimite} (${paso.diasRestantes} días).` : ""}

Escribe la apertura de este paso para el contador, en español de México:
1. Una frase con la situación del paso.
2. Qué hay que hacer, en orden, como lista corta (máximo 4 puntos). Cita las cifras de arriba tal cual cuando importen.
3. Si algo impide avanzar, dilo con precisión: qué falta y dónde se captura.

Reglas: no inventes cifras ni las recalcules; usa sólo las de arriba. NUNCA le pidas al contador un dato que aparezca en las cifras. Si una cifra viene "no disponible", di qué falta para tenerla. No saludes, no te presentes, no ofrezcas ayuda genérica. Máximo 130 palabras. Markdown mínimo (negritas y lista).`;
}

/**
 * Apertura del paso. Devuelve la cacheada si la evidencia no cambió; si no, la
 * escribe y la guarda. Ante cualquier fallo (tope de IA, API caída) devuelve el
 * detalle del motor: la pantalla nunca se queda sin texto.
 */
export async function aperturaDelPaso(args: {
  companyId: string;
  year: number;
  month: number;
  clave: ClavePasoCierre;
  userId: string;
  empresa: string;
}): Promise<AperturaPaso> {
  const { companyId, year, month, clave, userId, empresa } = args;
  const cierre = await evaluarCierre(companyId, year, month, { persistir: true });
  const paso = cierre.pasos.find((p) => p.clave === clave);
  if (!paso) return { texto: "Este paso no existe en el periodo.", cacheada: true };
  if (paso.estadoCalculado === "no_aplica") {
    return { texto: "Este paso no aplica a la empresa en este periodo.", cacheada: true };
  }

  const anclar = (texto: string, cacheada: boolean) =>
    anclarEnElHilo({
      companyId,
      year,
      month,
      clave,
      hash: paso.hashEvidencia,
      texto,
      responsableUserId: cierre.responsableUserId,
    }).then((mensajeId) => ({ texto, cacheada, mensajeId }));

  const fila = cierre.cierreId
    ? await prisma.pasoCierre.findUnique({
        where: { cierreId_clave: { cierreId: cierre.cierreId, clave } },
        select: { id: true, resumenCopiloto: true, resumenHash: true },
      })
    : null;
  if (fila?.resumenCopiloto && fila.resumenHash === paso.hashEvidencia) {
    return anclar(fila.resumenCopiloto, true);
  }

  const gate = await asegurarUsoIA({ userId, companyId });
  if (!gate.ok) {
    return anclar(paso.detalle ?? paso.descripcion, true);
  }

  try {
    const msg = await meteredCreate(
      anthropic,
      { companyId, userId, subtipo: "ai.cierre" },
      {
        model: MODELO,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt(paso, etiquetaPeriodo(year, month), empresa) }],
      }
    );
    const texto = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!texto) return anclar(paso.detalle ?? paso.descripcion, true);
    if (fila) {
      await prisma.pasoCierre.update({
        where: { id: fila.id },
        data: { resumenCopiloto: texto, resumenHash: paso.hashEvidencia },
      });
    }
    return anclar(texto, false);
  } catch (e) {
    console.error("[cierre/resumen] falló:", companyId, clave, e instanceof Error ? e.message : e);
    return anclar(paso.detalle ?? paso.descripcion, true);
  }
}
