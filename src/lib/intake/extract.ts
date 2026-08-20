import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { meteredCreate } from "@/lib/costos/anthropic";
import { INTAKE_PRODUCTS, productByKey } from "./config";
import { indexAskEmbedding, findSemanticDuplicate, titlesLookDuplicate } from "./dedupe";
import type { IntakeAskKind } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Agente de extracción: RawIntake/IntakeTranscript → CandidateAsk.
//
// El modo de falla es la SOBRE-extracción — un backlog con tickets fabricados
// es peor que no tener backlog — así que el prompt es deliberadamente
// conservador y todo lo dudoso se omite (queda en `notes`, no en tickets).
// Los mensajes de WhatsApp se agrupan por contacto en ventanas de hasta 6 h
// para extraer una conversación como conversación, no como nueve fragmentos.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.AI_EXTRACT_MODEL ?? process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const MODEL_FALLBACK = "claude-opus-4-8";
const MAX_TOKENS = 2048;

/** Pausa de conversación tras la cual una ventana se considera cerrada. */
export const LULL_MS = 30 * 60 * 1000;
/** Tope duro de la ventana: aunque sigan escribiendo, a las 6 h se extrae. */
export const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;

export type WaRow = { id: string; receivedAt: Date; phone: string; body: string; profileName: string | null };

export type WaBatch = { phone: string; profileName: string | null; rows: WaRow[] };

/**
 * Agrupa mensajes de WhatsApp sin procesar por contacto y decide qué ventanas
 * están LISTAS para extraer: la conversación lleva ≥30 min callada, o el
 * mensaje más viejo ya cumplió 6 h esperando. Pura y testeada.
 */
export function partitionWhatsappBatches(rows: WaRow[], now: Date): WaBatch[] {
  const byPhone = new Map<string, WaRow[]>();
  for (const r of rows) {
    const list = byPhone.get(r.phone) ?? [];
    list.push(r);
    byPhone.set(r.phone, list);
  }
  const ready: WaBatch[] = [];
  for (const [phone, list] of byPhone) {
    list.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    const newest = list[list.length - 1].receivedAt.getTime();
    const oldest = list[0].receivedAt.getTime();
    if (now.getTime() - newest >= LULL_MS || now.getTime() - oldest >= MAX_WINDOW_MS) {
      ready.push({ phone, profileName: list.find((r) => r.profileName)?.profileName ?? null, rows: list });
    }
  }
  return ready;
}

export type ExtractedAsk = {
  title: string;
  body: string;
  quote: string | null;
  quote_ts_sec: number | null;
  product: string | null;
  kind: IntakeAskKind;
  confidence: number;
};

export type ExtractionOutput = { asks: ExtractedAsk[]; notes: string };

const KIND_MAP: Record<string, IntakeAskKind> = {
  bug: "BUG",
  feature: "FEATURE",
  question: "QUESTION",
  noise: "NOISE",
};

/**
 * Parseo DEFENSIVO de la salida del modelo: acepta fences/prosa alrededor,
 * descarta asks malformados y aplica el piso de confianza (0.5) aquí — el
 * prompt lo pide, pero el código no confía en que el prompt se cumpla.
 */
export function parseExtractionOutput(text: string): ExtractionOutput {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { asks: [], notes: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { asks: [], notes: "" };
  }
  const obj = parsed as { asks?: unknown; notes?: unknown };
  const asks: ExtractedAsk[] = [];
  if (Array.isArray(obj.asks)) {
    for (const raw of obj.asks) {
      const a = raw as Record<string, unknown>;
      const title = typeof a.title === "string" ? a.title.trim() : "";
      const body = typeof a.body === "string" ? a.body.trim() : "";
      const kind = KIND_MAP[String(a.kind ?? "").toLowerCase()];
      const confidence = typeof a.confidence === "number" ? Math.min(1, Math.max(0, a.confidence)) : 0;
      if (!title || !body || !kind) continue;
      if (kind === "NOISE") continue; // ruido explícito: no genera ticket
      if (confidence < 0.5) continue;
      asks.push({
        title: title.slice(0, 200),
        body,
        quote: typeof a.quote === "string" && a.quote.trim() ? a.quote.trim() : null,
        quote_ts_sec: typeof a.quote_ts_sec === "number" && a.quote_ts_sec >= 0 ? Math.round(a.quote_ts_sec) : null,
        product: productByKey(typeof a.product === "string" ? a.product : null)?.key ?? null,
        kind,
        confidence,
      });
    }
  }
  return { asks, notes: typeof obj.notes === "string" ? obj.notes : "" };
}

function systemPrompt(): string {
  const catalogo = INTAKE_PRODUCTS.map((p) => `- ${p.key}: ${p.label} — ${p.description}`).join("\n");
  return `Eres el analista de intake de una suite de software contable mexicano. Recibes conversaciones de clientes (WhatsApp o transcripciones de llamadas de Zoom, en español) y extraes ÚNICAMENTE los pedidos de producto que el cliente realmente hizo.

Catálogo de productos (usa exactamente estas claves en "product"):
${catalogo}

Responde SOLO con JSON válido, sin prosa ni fences, con esta forma exacta:
{"asks":[{"title":"…","body":"…","quote":"…cita verbatim…","quote_ts_sec":842,"product":"contabilidados","kind":"bug|feature|question","confidence":0.85}],"notes":"resto del contexto sin pedidos"}

Reglas de conservadurismo — el modo de falla es sobre-extraer:
1. Extrae solo pedidos que el cliente HIZO. No extraigas cosas con las que estuvo de acuerdo, especulaciones ni comentarios al pasar.
2. "Sería bonito algún día" NO es un pedido. "No puedo hacer X" SÍ lo es.
3. Si dudas, omítelo y menciónalo en "notes". Un pedido perdido no cuesta nada; un ticket falso destruye la confianza en todo el backlog.
4. confidence < 0.5 → omítelo.
5. UN ask por necesidad distinta. No partas una necesidad en tres tickets.
6. "title" en español, imperativo y concreto (≤80 caracteres). "body" explica la necesidad en 1–3 frases. "quote" es la cita VERBATIM del cliente que sustenta el ask; "quote_ts_sec" solo cuando la fuente es una transcripción con tiempos.
7. "kind": bug = algo que debería funcionar y no funciona; feature = capacidad nueva; question = duda que no requiere cambio de producto.
8. Si el producto no es claro, usa la pista de atribución dada o null.`;
}

async function callExtractor(userContent: string, subtipo: string): Promise<ExtractionOutput> {
  const anthropic = new Anthropic();
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt(),
    messages: [{ role: "user" as const, content: userContent }],
  };
  let msg;
  try {
    msg = await meteredCreate(anthropic, { subtipo }, params);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 404 || status === 403) {
      msg = await meteredCreate(anthropic, { subtipo }, { ...params, model: MODEL_FALLBACK });
    } else {
      throw e;
    }
  }
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseExtractionOutput(text);
}

/** Títulos abiertos del mismo producto — contexto de dedupe para el prompt. */
async function openAskTitles(product: string | null): Promise<{ id: string; title: string; product: string | null }[]> {
  return prisma.candidateAsk.findMany({
    where: {
      status: { in: ["PENDING", "APPROVED", "AUTO_APPROVED"] },
      ...(product ? { product } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, title: true, product: true },
  });
}

async function createAsks(opts: {
  asks: ExtractedAsk[];
  rawIntakeId?: string;
  transcriptId?: string;
  contactId?: string | null;
  productHint: string | null;
}): Promise<number> {
  let created = 0;
  for (const a of opts.asks) {
    const product = a.product ?? opts.productHint;
    // Dedupe pase 1: similitud de título contra los asks abiertos del producto.
    const abiertos = await openAskTitles(product);
    const porTitulo = abiertos.find((o) => titlesLookDuplicate(o.title, a.title));

    const ask = await prisma.candidateAsk.create({
      data: {
        rawIntakeId: opts.rawIntakeId ?? null,
        transcriptId: opts.transcriptId ?? null,
        contactId: opts.contactId ?? null,
        product,
        kind: a.kind,
        title: a.title,
        body: a.body,
        quote: a.quote,
        quoteTsSec: a.quote_ts_sec,
        confidence: a.confidence,
        dedupeOfId: porTitulo?.id ?? null,
      },
    });
    created++;

    // Dedupe pase 2 (semántico, best-effort): embedding + coseno vs. abiertos.
    // Se marca (`dedupeOf`), nunca se auto-fusiona — la tarjeta de Telegram
    // ofrecerá "merge" y el humano decide.
    try {
      const embedding = await indexAskEmbedding(ask.id, `${a.title}\n${a.body}`);
      if (!ask.dedupeOfId && embedding) {
        const dup = await findSemanticDuplicate(ask.id, product, embedding);
        if (dup) {
          await prisma.candidateAsk.update({ where: { id: ask.id }, data: { dedupeOfId: dup.id } });
        }
      }
    } catch (e) {
      console.error("[intake] embedding dedupe failed", ask.id, e instanceof Error ? e.message : e);
    }
  }
  return created;
}

function renderWaConversation(batch: WaBatch): string {
  const lines = batch.rows.map((r) => {
    const t = r.receivedAt.toISOString().slice(0, 16).replace("T", " ");
    return `[${t}] Cliente: ${r.body}`;
  });
  return lines.join("\n");
}

/**
 * Corre la extracción sobre lo pendiente: ventanas de WhatsApp listas y
 * transcripciones de Zoom sin extraer. Devuelve conteos para el ritmo
 * adaptativo del scheduler.
 */
export async function runExtractPending(): Promise<{
  batches: number;
  transcripts: number;
  asksCreated: number;
  pending: number;
}> {
  const now = new Date();
  let asksCreated = 0;

  // ── WhatsApp: ventanas por contacto ────────────────────────────────────────
  const waRows = await prisma.rawIntake.findMany({
    where: { source: "WHATSAPP", processedAt: null },
    orderBy: { receivedAt: "asc" },
    take: 500,
  });
  const rows: WaRow[] = waRows.map((r) => {
    const p = r.payload as { phone?: string; body?: string; profileName?: string | null };
    return { id: r.id, receivedAt: r.receivedAt, phone: p.phone ?? "?", body: p.body ?? "", profileName: p.profileName ?? null };
  });
  const batches = partitionWhatsappBatches(rows, now);

  for (const batch of batches) {
    const ids = batch.rows.map((r) => r.id);
    try {
      const contact = await prisma.intakeContact.upsert({
        where: { phoneE164: batch.phone },
        update: batch.profileName ? { displayName: batch.profileName } : {},
        create: { phoneE164: batch.phone, displayName: batch.profileName },
      });
      const abiertos = await openAskTitles(contact.primaryProduct);
      const contexto = [
        `Fuente: conversación de WhatsApp con ${batch.profileName ?? batch.phone}.`,
        contact.primaryProduct ? `Pista de atribución: el contacto usa principalmente "${contact.primaryProduct}".` : "",
        abiertos.length ? `Asks ya abiertos (para que NO dupliques):\n${abiertos.map((t) => `- ${t.title}`).join("\n")}` : "",
        "",
        renderWaConversation(batch),
      ].filter(Boolean).join("\n");

      const out = await callExtractor(contexto, "intake.extract_whatsapp");
      asksCreated += await createAsks({
        asks: out.asks,
        rawIntakeId: ids[ids.length - 1],
        contactId: contact.id,
        productHint: contact.primaryProduct,
      });
      await prisma.rawIntake.updateMany({
        where: { id: { in: ids } },
        data: { processedAt: new Date(), processError: null },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[intake] extract whatsapp batch failed", batch.phone, msg);
      await prisma.rawIntake.updateMany({
        where: { id: { in: ids } },
        data: { processError: msg.slice(0, 500) }, // processedAt queda null → se reintenta
      });
    }
  }

  // ── Transcripciones de Zoom ────────────────────────────────────────────────
  const transcripts = await prisma.intakeTranscript.findMany({
    where: { extractedAt: null },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  for (const t of transcripts) {
    try {
      const abiertos = await openAskTitles(t.productHint);
      const segs = (t.segments as { speaker?: string; start?: number; text?: string }[]) ?? [];
      const cuerpo = segs.length
        ? segs.map((s) => `[${s.start ?? 0}s] ${s.speaker ?? "S?"}: ${s.text ?? ""}`).join("\n")
        : t.fullText;
      const contexto = [
        `Fuente: transcripción de llamada de Zoom "${t.meetingTopic ?? "(sin título)"}".`,
        t.productHint ? `Pista de atribución (del nombre de la reunión): "${t.productHint}".` : "",
        `Los prefijos [Ns] son segundos desde el inicio — úsalos para "quote_ts_sec".`,
        abiertos.length ? `Asks ya abiertos (para que NO dupliques):\n${abiertos.map((x) => `- ${x.title}`).join("\n")}` : "",
        "",
        cuerpo.slice(0, 150_000),
      ].filter(Boolean).join("\n");

      const out = await callExtractor(contexto, "intake.extract_zoom");
      asksCreated += await createAsks({
        asks: out.asks,
        rawIntakeId: t.rawIntakeId,
        transcriptId: t.id,
        productHint: t.productHint,
      });
      await prisma.intakeTranscript.update({ where: { id: t.id }, data: { extractedAt: new Date() } });
    } catch (e) {
      console.error("[intake] extract transcript failed", t.id, e instanceof Error ? e.message : e);
    }
  }

  // "Pendiente" para el ritmo adaptativo = trabajo ACCIONABLE ya (ventanas
  // listas + transcripciones sin extraer). Los mensajes esperando su pausa de
  // 30 min NO cuentan — reportarlos aceleraría el scheduler sin nada que hacer.
  const waLeft = await prisma.rawIntake.findMany({
    where: { source: "WHATSAPP", processedAt: null },
    orderBy: { receivedAt: "asc" },
    take: 500,
  });
  const readyLeft = partitionWhatsappBatches(
    waLeft.map((r) => {
      const p = r.payload as { phone?: string; body?: string; profileName?: string | null };
      return { id: r.id, receivedAt: r.receivedAt, phone: p.phone ?? "?", body: p.body ?? "", profileName: p.profileName ?? null };
    }),
    new Date()
  ).length;
  const pendingTr = await prisma.intakeTranscript.count({ where: { extractedAt: null } });
  return { batches: batches.length, transcripts: transcripts.length, asksCreated, pending: readyLeft + pendingTr };
}
