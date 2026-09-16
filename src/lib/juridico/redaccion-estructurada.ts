// ─────────────────────────────────────────────────────────────────────────────
// Redacción por esquema: cómo se escribe un documento largo sin perderse.
//
//   1. planear_documento      → el esquema (secciones con propósito, datos y
//                               normas), guardado como borrador en estado
//                               «esquema» para que el abogado lo corrija antes
//                               de que exista prosa.
//   2. redactar_por_secciones → cada sección en su propia llamada al modelo,
//                               con el asunto (partes de la BD, decisiones),
//                               el esquema, las secciones ya escritas y las
//                               normas recuperadas para esa sección; después
//                               una pasada de coherencia (términos definidos,
//                               referencias cruzadas, numeración) que emite
//                               correcciones puntuales, no una reescritura.
//   3. revisar_documento      → la relectura antes de entregar: partes contra
//                               la BD, alcance y decisiones, contenido
//                               obligatorio, [___] pendientes, citas
//                               verificables. Observaciones por sección; lo
//                               mecánico se corrige solo.
//   4. editar_seccion         → cambios por sección con el resto como
//                               contexto; cada cambio guarda la versión
//                               anterior.
//
// Corre dentro del turno (que es reanudable) y va avisando por SSE
// («documento_progreso»). Lo puro —armar y partir el documento, aplicar
// correcciones— se prueba en redaccion-estructurada.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apuntar } from "./bitacora";
import { guardarVersion } from "./versiones";
import { recordLlmCost, type CostCtx } from "@/lib/costos/record";
import { searchFiscalKnowledge } from "@/lib/fiscal-kb/search";
import { extraerCitas } from "@/lib/ai/eval/medidas";
import { bloqueAsuntoParaPrompt, type Asunto } from "./asuntos";
import { indexarDocumento, limpiarTexto, type DocumentoCargado } from "./documentos";
import { MIME_BORRADOR, type DocumentoResumen } from "./redaccion";

export interface PlanSeccion {
  n: number;
  titulo: string; // «PRIMERA.- OBJETO» | «Hechos» | «Excepciones y defensas»
  proposito: string;
  datos?: string[]; // qué datos del asunto usa
  normas?: string[]; // qué normas debe respetar / citar
  markdown?: string; // texto ya redactado
  fundamentos?: string[]; // citas que devolvió la base para esta sección
}

export interface Plan {
  titulo: string;
  tipo: string;
  secciones: PlanSeccion[];
  notas?: string;
  instrucciones?: string;
}

export interface Observacion {
  seccion?: number;
  gravedad: "alta" | "media" | "baja";
  texto: string;
}

export interface Revision {
  fecha: string;
  observaciones: Observacion[];
  citasNoVerificables: string[];
  listo: boolean;
  modelo: string;
}

export interface Version {
  fecha: string;
  motivo: string;
  markdown: string;
}

export type Emitir = (e: Record<string, unknown> & { type: string }) => void;

const MODELO = process.env.AI_REDACCION_MODEL ?? process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const MODELO_RESPALDO = "claude-opus-4-8";
const FUENTES_NORMATIVA = ["LEY", "REGLAMENTO", "RMF", "CRITERIO", "DOF", "GUIA"];
const SECCIONES_EN_PARALELO = 3;
const MAX_CONTEXTO_PREVIO = 40_000;
const MAX_VERSIONES = 20;

// ── Armar y partir ───────────────────────────────────────────────────────────

/** El esquema como Markdown (lo que se ve y se baja mientras no hay prosa). */
export function esquemaComoMarkdown(plan: Plan): string {
  const l = [`# ${plan.titulo}`, "", `_Esquema (${plan.tipo}). Aún sin redactar: revisa las secciones, sus propósitos y las normas, y pide que se redacte._`, ""];
  for (const s of plan.secciones) {
    l.push(`## ${s.n}. ${s.titulo}`, "", s.proposito);
    if (s.datos?.length) l.push("", `Datos: ${s.datos.join("; ")}`);
    if (s.normas?.length) l.push("", `Normas: ${s.normas.join("; ")}`);
    l.push("");
  }
  if (plan.notas) l.push("---", "", plan.notas, "");
  return l.join("\n");
}

/** El documento completo a partir de las secciones redactadas. */
export function armarDocumento(plan: Plan): string {
  const l = [`# ${plan.titulo}`, ""];
  for (const s of plan.secciones) {
    const md = (s.markdown ?? "").trim();
    l.push(md || `_[Sección ${s.n} «${s.titulo}» pendiente de redactar]_`, "");
  }
  return l.join("\n").trim() + "\n";
}

/** Aplica correcciones puntuales {n, markdown} sobre el plan; ignora secciones inexistentes o vacías. */
export function aplicarCorrecciones(plan: Plan, correcciones: { n: number; markdown: string }[]): { plan: Plan; aplicadas: number } {
  let aplicadas = 0;
  const secciones = plan.secciones.map((s) => ({ ...s }));
  for (const c of correcciones) {
    const s = secciones.find((x) => x.n === c.n);
    if (!s || typeof c.markdown !== "string" || c.markdown.trim().length < 20) continue;
    s.markdown = c.markdown.trim();
    aplicadas++;
  }
  return { plan: { ...plan, secciones }, aplicadas };
}

/** Localiza una sección por número o por título (sin acentos, parcial). */
export function buscarSeccion(plan: Plan, ref: number | string): PlanSeccion | undefined {
  if (typeof ref === "number") return plan.secciones.find((s) => s.n === ref);
  const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const r = norm(String(ref)).trim();
  if (/^\d+$/.test(r)) return plan.secciones.find((s) => s.n === Number(r));
  return plan.secciones.find((s) => norm(s.titulo).includes(r)) ?? plan.secciones.find((s) => r.includes(norm(s.titulo).split(".")[0]));
}

function json<T>(texto: string, abre: string, cierra: string): T | null {
  const i = texto.indexOf(abre);
  const j = texto.lastIndexOf(cierra);
  if (i < 0 || j < i) return null;
  try {
    return JSON.parse(texto.slice(i, j + 1)) as T;
  } catch {
    return null;
  }
}

// ── Modelo ───────────────────────────────────────────────────────────────────

/**
 * Un trozo del mensaje del usuario. `cachear` pide un punto de caché DESPUÉS de
 * este trozo: todo lo anterior se lee a una décima parte del precio en la
 * llamada siguiente.
 */
export interface TrozoUser {
  texto: string;
  cachear?: boolean;
}

/**
 * Mínimo de caracteres para que valga la pena pedir caché. Anthropic no cachea
 * prefijos de menos de ~1024 tokens: pedirlo por debajo no falla, simplemente
 * se ignora en silencio. Con ~3.5 caracteres por token en español, 3 600.
 */
const MIN_CHARS_CACHE = 3_600;

/**
 * Arma el mensaje del usuario poniendo los puntos de caché donde de verdad
 * sirven. Puro, para poder probarlo.
 *
 * Por qué existe: antes el `cache_control` iba en el `system`, que aquí son
 * frases de 124 caracteres («Eres un abogado revisor…»). Por debajo del mínimo
 * Anthropic lo ignora sin decir nada, así que PARECÍA cacheado y no lo estaba,
 * mientras el bulto de verdad —el asunto, el esquema, las secciones ya escritas
 * y el documento entero— viajaba en el mensaje del usuario a precio completo en
 * cada sección. Medido en producción: 0 tokens leídos de caché en redacción y
 * revisión, todos los días.
 */
export function bloquesDeUser(trozos: string | TrozoUser[]): Anthropic.TextBlockParam[] {
  if (typeof trozos === "string") return [{ type: "text", text: trozos }];
  const bloques: Anthropic.TextBlockParam[] = [];
  let acumulado = 0;
  let puntos = 0;
  for (const t of trozos) {
    if (!t.texto) continue;
    acumulado += t.texto.length;
    const bloque: Anthropic.TextBlockParam = { type: "text", text: t.texto };
    // El límite del API son cuatro puntos por petición; aquí se gastan dos como
    // mucho y el prefijo tiene que dar el mínimo para que no sea un gesto vacío.
    if (t.cachear && acumulado >= MIN_CHARS_CACHE && puntos < 2) {
      bloque.cache_control = { type: "ephemeral" };
      puntos++;
    }
    bloques.push(bloque);
  }
  return bloques.length > 0 ? bloques : [{ type: "text", text: "" }];
}

/**
 * El encabezado con el documento entero, tal como lo mandan la pasada de
 * coherencia y la relectura final. Es UNA función a propósito: las dos
 * llamadas comparten el prefijo de caché sólo si el texto es idéntico byte a
 * byte, y dos plantillas parecidas escritas en dos lugares distintos se
 * separan en cuanto alguien toca una.
 */
export function encabezadoConDocumento(secciones: { n: number; titulo: string }[], doc: string): string {
  return ["Secciones:", secciones.map((s) => `[${s.n}] ${s.titulo}`).join("\n"), "", "Documento:", doc.slice(0, 120_000)].join("\n");
}

async function llamar(anthropic: Anthropic, args: { system: string; user: string | TrozoUser[]; maxTokens: number; cost: CostCtx; subtipo: string }): Promise<string> {
  let modelo = MODELO;
  for (;;) {
    try {
      // El caché va en el MENSAJE, no en el system: estos system son frases
      // cortas, por debajo del mínimo que Anthropic cachea.
      const res = await anthropic.messages.create({
        model: modelo,
        max_tokens: args.maxTokens,
        system: args.system,
        messages: [{ role: "user", content: bloquesDeUser(args.user) }],
      });
      await recordLlmCost(modelo, res.usage, { ...args.cost, subtipo: args.subtipo });
      return res.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
    } catch (err) {
      if (modelo !== MODELO_RESPALDO && err instanceof Anthropic.NotFoundError) {
        modelo = MODELO_RESPALDO;
        continue;
      }
      throw err;
    }
  }
}

const SYSTEM_REDACTOR = `Eres un abogado mexicano senior redactando un documento para un colega. Escribes en español jurídico claro, preciso y sin relleno. Los nombres, RFC, CURP, domicilios, montos, fechas y expediente salen SOLO del asunto que te dan; lo que no esté ahí va como [___]. No inventas hechos ni artículos: citas únicamente las normas que vienen en «Normas recuperadas», por su cita exacta. Respetas las decisiones del abogado al pie de la letra.`;

async function normasPara(seccion: PlanSeccion, plan: Plan, cost: CostCtx): Promise<{ texto: string; citas: string[] }> {
  const consulta = [seccion.titulo, seccion.proposito, ...(seccion.normas ?? [])].join(". ").slice(0, 400);
  try {
    const r = await searchFiscalKnowledge(consulta, { fuentes: FUENTES_NORMATIVA, limit: 6, cost });
    const hits = r.resultados.slice(0, 6);
    if (!hits.length) return { texto: "(la base no devolvió normas para esta sección: no cites artículos)", citas: [] };
    return { texto: hits.map((h) => `— ${h.cita}\n${h.texto.slice(0, 1_200)}`).join("\n\n"), citas: hits.map((h) => h.cita) };
  } catch {
    return { texto: "(la base no está disponible: no cites artículos)", citas: [] };
  }
}

function contextoPrevio(plan: Plan, hasta: number): string {
  const previas = plan.secciones.filter((s) => s.n < hasta && s.markdown);
  let total = previas.reduce((a, s) => a + (s.markdown?.length ?? 0), 0);
  if (total <= MAX_CONTEXTO_PREVIO) return previas.map((s) => s.markdown).join("\n\n");
  // Demasiado largo: las primeras (definiciones, partes) completas; el resto, su arranque.
  const out: string[] = [];
  total = 0;
  for (const s of previas) {
    const md = s.markdown!;
    const trozo = total < MAX_CONTEXTO_PREVIO / 2 ? md : md.slice(0, 600) + " […]";
    out.push(trozo);
    total += trozo.length;
  }
  return out.join("\n\n");
}

async function redactarSeccion(anthropic: Anthropic, plan: Plan, seccion: PlanSeccion, asunto: Asunto | null, cost: CostCtx, instrucciones?: string): Promise<{ markdown: string; citas: string[] }> {
  const normas = await normasPara(seccion, plan, cost);
  const unir = (ls: (string | false | undefined)[]) => ls.filter((l): l is string => !!l && l !== "").join("\n");
  // El orden NO es cosmético: manda el caché. Primero lo que no cambia en todo
  // el documento, luego lo que sólo crece, y al final lo de esta sección. Así
  // la sección 7 lee de caché todo lo que ya viajó en la 6 en vez de pagarlo.
  const estable = unir([
    bloqueAsuntoParaPrompt(asunto),
    `## Documento: ${plan.titulo} (${plan.tipo})`,
    plan.instrucciones ? `Instrucciones generales: ${plan.instrucciones}` : "",
    "",
    "## Esquema completo",
    plan.secciones.map((s) => `${s.n}. ${s.titulo} — ${s.proposito}`).join("\n"),
  ]);
  // Crece con cada sección, pero siempre empezando igual: el prefijo compartido
  // con la llamada anterior se lee de caché.
  const previas = unir([
    "",
    "## Secciones ya redactadas (mantén sus términos definidos, nombres, numeración y referencias)",
    contextoPrevio(plan, seccion.n) || "(ninguna todavía)",
  ]);
  const deEstaSeccion = unir([
    "",
    `## Normas recuperadas para la sección ${seccion.n}`,
    normas.texto,
    "",
    `## Redacta AHORA sólo la sección ${seccion.n}: «${seccion.titulo}»`,
    `Propósito: ${seccion.proposito}`,
    seccion.datos?.length ? `Datos que usa: ${seccion.datos.join("; ")}` : "",
    seccion.normas?.length ? `Debe respetar: ${seccion.normas.join("; ")}` : "",
    instrucciones ? `Instrucciones específicas: ${instrucciones}` : "",
    "",
    "Formato: Markdown. Si es una cláusula, empieza con su título en negritas al inicio del párrafo («**PRIMERA.- OBJETO.**»); si es un apartado (Hechos, Derecho, Pruebas, Puntos petitorios), empieza con «## Título». Numera hechos y fracciones. Sin comentarios, sin notas al abogado, sin repetir otras secciones: sólo el texto final de esta sección.",
  ]);
  const markdown = await llamar(anthropic, {
    system: SYSTEM_REDACTOR,
    user: [{ texto: estable, cachear: true }, { texto: previas, cachear: true }, { texto: deEstaSeccion }],
    maxTokens: 4_000,
    cost,
    subtipo: "ai.juridico.redaccion",
  });
  return { markdown, citas: normas.citas };
}

async function pasadaDeCoherencia(anthropic: Anthropic, plan: Plan, cost: CostCtx): Promise<{ n: number; markdown: string }[]> {
  const doc = armarDocumento(plan);
  // El documento va PRIMERO y con punto de caché: es el bulto, es idéntico al
  // que releerá `revisar_documento` después, y así la segunda llamada lo lee a
  // una décima parte en vez de reenviarlo entero.
  const encabezado = encabezadoConDocumento(plan.secciones, doc);
  const out = await llamar(anthropic, {
    system: "Eres un abogado revisor. Sólo coherencia interna. Respondes con JSON.",
    user: [
      { texto: encabezado, cachear: true },
      { texto: `\nRevisa la COHERENCIA de este documento redactado por secciones: términos definidos que cambian de nombre, referencias cruzadas rotas («la cláusula anterior», «el artículo 5» cuando es el 7), numeración, partes llamadas distinto, datos que difieren entre secciones, repeticiones. Devuelve SOLO JSON con las secciones que haya que corregir, con su texto completo corregido: {"correcciones":[{"n":<número>,"markdown":"<texto completo de la sección>"}]}. Si no hay nada que corregir: {"correcciones":[]}. No cambies el fondo ni añadas contenido.` },
    ],
    maxTokens: 12_000,
    cost,
    subtipo: "ai.juridico.redaccion",
  });
  return json<{ correcciones: { n: number; markdown: string }[] }>(out, "{", "}")?.correcciones ?? [];
}

// ── Persistencia ─────────────────────────────────────────────────────────────

const selectDoc = { id: true, nombre: true, mime: true, bytes: true, paginas: true, caracteres: true, createdAt: true, estado: true, plan: true, revision: true, versiones: true } as const;

async function guardar(
  docId: string | null,
  ctx: { userId: string; conversacionId: string },
  plan: Plan,
  estado: string,
  extra: { revision?: Revision | null; motivoVersion?: string }
): Promise<{ resumen: DocumentoResumen & { estado: string; revision?: Revision | null }; cargado: DocumentoCargado }> {
  const markdown = estado === "esquema" ? esquemaComoMarkdown(plan) : armarDocumento(plan);
  const texto = limpiarTexto(markdown);
  const secciones = indexarDocumento(texto);
  const datos = {
    nombre: `${plan.titulo}.docx`.slice(0, 200),
    mime: MIME_BORRADOR,
    bytes: Buffer.byteLength(texto, "utf8"),
    hash: createHash("sha256").update(texto).digest("hex"),
    paginas: null,
    caracteres: texto.length,
    texto,
    secciones: secciones as unknown as Prisma.InputJsonValue,
    plan: plan as unknown as Prisma.InputJsonValue,
    estado,
    revision: extra.revision === undefined ? undefined : (extra.revision as unknown as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
  };
  // El caso del documento: se hereda de la conversación (Fase 1).
  const conv = await prisma.juridicoConversacion.findUnique({ where: { id: ctx.conversacionId }, select: { casoId: true } });
  const casoId = conv?.casoId ?? null;
  let doc;
  if (docId) {
    const previo = await prisma.juridicoDocumento.findFirst({ where: { id: docId, conversacionId: ctx.conversacionId, userId: ctx.userId }, select: { texto: true, estado: true, versiones: true, plan: true } });
    if (!previo) throw new Error("Borrador no encontrado en esta conversación");
    const versiones = ((previo.versiones as unknown as Version[] | null) ?? []).slice(-(MAX_VERSIONES - 1));
    if (extra.motivoVersion && previo.estado !== "esquema" && previo.texto.trim()) {
      versiones.push({ fecha: new Date().toISOString(), motivo: extra.motivoVersion, markdown: previo.texto });
      // Y con autor, que es lo que sirve de evidencia: la versión ANTERIOR,
      // congelada antes de sobrescribirla, firmada por quien pidió el cambio.
      await guardarVersion({ documentoId: docId, texto: previo.texto, plan: previo.plan, planNuevo: plan, actor: { userId: ctx.userId, tipo: "copiloto" }, motivo: extra.motivoVersion, casoId });
    }
    doc = await prisma.juridicoDocumento.update({ where: { id: docId }, data: { ...datos, casoId, versiones: versiones as unknown as Prisma.InputJsonValue }, select: selectDoc });
  } else {
    doc = await prisma.juridicoDocumento.create({ data: { ...datos, casoId, conversacionId: ctx.conversacionId, userId: ctx.userId }, select: selectDoc });
    if (casoId) await apuntar({ casoId, actor: { userId: ctx.userId, tipo: "copiloto" }, accion: "documento.creado", entidad: "documento", entidadId: doc.id, resumen: `redactó «${doc.nombre}»`, datos: { estado } });
  }
  await prisma.juridicoConversacion.update({ where: { id: ctx.conversacionId }, data: { updatedAt: new Date() } });
  const { plan: _p, versiones: _v, revision, ...resto } = doc;
  return {
    resumen: { ...resto, transcrito: false, revision: (revision as unknown as Revision | null) ?? null },
    cargado: { id: doc.id, nombre: doc.nombre, paginas: null, caracteres: texto.length, texto, secciones },
  };
}

async function cargarPlan(docId: string, ctx: { userId: string; conversacionId: string }): Promise<{ plan: Plan; estado: string } | null> {
  const d = await prisma.juridicoDocumento.findFirst({ where: { id: docId, conversacionId: ctx.conversacionId, userId: ctx.userId, mime: MIME_BORRADOR }, select: { plan: true, estado: true } });
  const plan = d?.plan as unknown as Plan | null;
  return plan && Array.isArray(plan.secciones) ? { plan, estado: d!.estado } : null;
}

// ── Herramientas ─────────────────────────────────────────────────────────────

export const toolsRedaccionEstructurada: Anthropic.Tool[] = [
  {
    name: "planear_documento",
    description:
      "Paso 1 para cualquier documento de más de ~6 secciones (contrato de fondo, contestación de demanda, demanda, convenio, alegatos): guarda el ESQUEMA —título, tipo y cada sección con su propósito, los datos del asunto que usa y las normas que debe respetar— como borrador en estado «esquema», para que el abogado lo corrija antes de que exista prosa. Incluye todo lo que el documento necesita en México (proemio con partes, declaraciones, definiciones si hacen falta, cláusulas de fondo, vigencia, incumplimiento, jurisdicción, notificaciones, firmas; o rubro, proemio, prestaciones/hechos/derecho/pruebas/petitorios en un escrito). Después: redactar_por_secciones.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        tipo: { type: "string", description: "contrato | convenio | demanda | contestacion | alegatos | escrito | dictamen | otro" },
        instrucciones: { type: "string", description: "Instrucciones generales para toda la redacción (tono, extensión, a favor de quién, qué evitar)." },
        secciones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              titulo: { type: "string", description: "«PRIMERA.- OBJETO», «Declaraciones», «Hechos», «Excepciones y defensas»…" },
              proposito: { type: "string", description: "Qué debe lograr la sección, en 1–3 líneas." },
              datos: { type: "array", items: { type: "string" }, description: "Datos del asunto que usa (partes, montos, fechas, expediente)." },
              normas: { type: "array", items: { type: "string" }, description: "Normas que rigen esta sección (nombre del ordenamiento y tema; el artículo lo trae la base)." },
            },
            required: ["titulo", "proposito"],
          },
        },
        notas: { type: "string", description: "Lo que falta decidir o preguntar antes de redactar." },
        documento_id: { type: "string", description: "Id de un esquema ya guardado para sustituirlo." },
      },
      required: ["titulo", "tipo", "secciones"],
    },
  },
  {
    name: "redactar_por_secciones",
    description:
      "Paso 2: redacta el documento sección por sección a partir de su esquema (cada sección con el asunto, las secciones anteriores y las normas que la base devuelve para ella), lo ensambla y hace una pasada de coherencia. Tarda un par de minutos; el usuario ve el avance. Al terminar queda en estado «borrador»: antes de entregarlo, revisar_documento.",
    input_schema: {
      type: "object",
      properties: {
        documento_id: { type: "string", description: "Id del esquema (lo devuelve planear_documento)." },
        secciones: { type: "array", items: { type: "integer" }, description: "Sólo estas secciones (por número); si se omite, todas las que falten." },
        instrucciones: { type: "string", description: "Instrucciones adicionales para esta redacción." },
      },
      required: ["documento_id"],
    },
  },
  {
    name: "revisar_documento",
    description:
      "Paso 3, obligatorio antes de decir que un documento está listo: relectura completa contra el asunto (partes, RFC, montos y fechas contra la base), el objetivo y las decisiones del abogado, el contenido obligatorio para ese tipo de documento, términos definidos y referencias cruzadas, datos [___] pendientes y citas verificables. Devuelve observaciones por sección con gravedad; las mecánicas se corrigen solas. El documento queda «revisado» sólo si no hay observaciones altas.",
    input_schema: { type: "object", properties: { documento_id: { type: "string" } }, required: ["documento_id"] },
  },
  {
    name: "editar_seccion",
    description: "Cambia UNA sección de un borrador redactado por esquema, con el resto del documento como contexto, y guarda la versión anterior. Úsala cuando el usuario pida cambiar una cláusula o apartado; no reescribas el documento entero.",
    input_schema: {
      type: "object",
      properties: {
        documento_id: { type: "string" },
        seccion: { type: "string", description: "Número o título de la sección («7», «JURISDICCIÓN», «Hechos»)." },
        instrucciones: { type: "string", description: "Qué cambiar y cómo." },
      },
      required: ["documento_id", "seccion", "instrucciones"],
    },
  },
];

export const NOMBRES_REDACCION_ESTRUCTURADA = new Set(toolsRedaccionEstructurada.map((t) => t.name));

export interface CtxRedaccion {
  anthropic: Anthropic;
  userId: string;
  conversacionId: string;
  asunto: Asunto | null;
  emitir: Emitir;
}

export async function ejecutarRedaccionEstructurada(nombre: string, input: Record<string, unknown>, ctx: CtxRedaccion): Promise<{ salida: string; documento?: DocumentoResumen; cargado?: DocumentoCargado }> {
  const cost: CostCtx = { companyId: null, userId: ctx.userId, subtipo: "ai.juridico.redaccion" };
  const docId = typeof input.documento_id === "string" && input.documento_id.trim() ? input.documento_id.trim() : null;

  if (nombre === "planear_documento") {
    const secciones = (Array.isArray(input.secciones) ? (input.secciones as Record<string, unknown>[]) : [])
      .filter((s) => typeof s.titulo === "string" && typeof s.proposito === "string")
      .map((s, i) => ({ n: i + 1, titulo: String(s.titulo).trim().slice(0, 120), proposito: String(s.proposito).trim().slice(0, 600), datos: Array.isArray(s.datos) ? s.datos.map(String).slice(0, 12) : undefined, normas: Array.isArray(s.normas) ? s.normas.map(String).slice(0, 8) : undefined }));
    if (!secciones.length || typeof input.titulo !== "string") return { salida: JSON.stringify({ error: "El esquema necesita título y al menos una sección con propósito.", resumen: "esquema vacío" }) };
    const plan: Plan = { titulo: String(input.titulo).trim().slice(0, 180), tipo: typeof input.tipo === "string" ? input.tipo : "otro", secciones, notas: typeof input.notas === "string" ? input.notas : undefined, instrucciones: typeof input.instrucciones === "string" ? input.instrucciones : undefined };
    const g = await guardar(docId, ctx, plan, "esquema", {});
    ctx.emitir({ type: "documento", documento: g.resumen });
    return {
      salida: JSON.stringify({ documento_id: g.resumen.id, secciones: secciones.length, estado: "esquema", instruccion: "Esquema guardado; el usuario lo ve como borrador «esquema». Resume en pocas líneas qué contiene y qué falta decidir, y ofrece redactarlo (redactar_por_secciones) o ajustarlo primero.", resumen: `esquema «${plan.titulo.slice(0, 40)}» · ${secciones.length} secciones` }),
      documento: g.resumen,
      cargado: g.cargado,
    };
  }

  if (!docId) return { salida: JSON.stringify({ error: "Falta documento_id.", resumen: "sin documento" }) };
  const actual = await cargarPlan(docId, ctx);
  if (!actual) return { salida: JSON.stringify({ error: "Ese documento no tiene esquema; sólo los creados con planear_documento se redactan por secciones.", resumen: "sin esquema" }) };
  const plan: Plan = { ...actual.plan, secciones: actual.plan.secciones.map((s) => ({ ...s })) };

  if (nombre === "redactar_por_secciones") {
    const solo = Array.isArray(input.secciones) ? new Set((input.secciones as unknown[]).map(Number)) : null;
    const instrucciones = typeof input.instrucciones === "string" ? input.instrucciones : undefined;
    const pendientes = plan.secciones.filter((s) => (solo ? solo.has(s.n) : !s.markdown));
    if (!pendientes.length) return { salida: JSON.stringify({ aviso: "No hay secciones pendientes; para cambiar una usa editar_seccion.", resumen: "nada pendiente" }) };
    const total = pendientes.length;
    let hechas = 0;
    // Olas de 3: cada sección ve las anteriores ya escritas (las de su ola sólo las de olas previas).
    for (let i = 0; i < pendientes.length; i += SECCIONES_EN_PARALELO) {
      const ola = pendientes.slice(i, i + SECCIONES_EN_PARALELO);
      await Promise.all(
        ola.map(async (s) => {
          ctx.emitir({ type: "documento_progreso", documento_id: docId, seccion: s.n, de: plan.secciones.length, titulo: s.titulo, hechas, total });
          const r = await redactarSeccion(ctx.anthropic, plan, s, ctx.asunto, cost, instrucciones);
          s.markdown = r.markdown;
          s.fundamentos = r.citas;
          hechas++;
        })
      );
      // Guardado parcial: si el turno muere a media redacción, no se pierde lo hecho.
      await guardar(docId, ctx, plan, "redactando", {});
    }
    ctx.emitir({ type: "documento_progreso", documento_id: docId, seccion: 0, de: plan.secciones.length, titulo: "coherencia", hechas, total });
    let aplicadas = 0;
    try {
      const correcciones = await pasadaDeCoherencia(ctx.anthropic, plan, cost);
      const r = aplicarCorrecciones(plan, correcciones);
      plan.secciones = r.plan.secciones;
      aplicadas = r.aplicadas;
    } catch {
      /* sin pasada de coherencia: el borrador sigue valiendo */
    }
    const g = await guardar(docId, ctx, plan, "borrador", { revision: null, motivoVersion: actual.estado === "borrador" || actual.estado === "revisado" ? "redacción nueva" : undefined });
    ctx.emitir({ type: "documento", documento: g.resumen });
    const faltantes = (g.cargado.texto.match(/\[_{2,}\]/g) ?? []).length;
    return {
      salida: JSON.stringify({ documento_id: docId, secciones_redactadas: total, correcciones_de_coherencia: aplicadas, caracteres: g.cargado.caracteres, datos_faltantes: faltantes, fundamentos: [...new Set(plan.secciones.flatMap((s) => s.fundamentos ?? []))].slice(0, 40), instruccion: "Borrador completo y guardado (estado «borrador»). Antes de darlo por listo corre revisar_documento. Al usuario: en pocas líneas, qué decidiste, qué falta ([___]) y qué debe revisar; no repitas el texto.", resumen: `${total} secciones redactadas · ${aplicadas} correcciones de coherencia` }),
      documento: g.resumen,
      cargado: g.cargado,
    };
  }

  if (nombre === "revisar_documento") {
    if (plan.secciones.some((s) => !s.markdown)) return { salida: JSON.stringify({ error: "Hay secciones sin redactar; primero redactar_por_secciones.", resumen: "incompleto" }) };
    const doc = armarDocumento(plan);
    const citas = extraerCitas(doc);
    const conocidas = new Set(plan.secciones.flatMap((s) => s.fundamentos ?? []));
    const citasNoVerificables = citas.filter((c) => ![...conocidas].some((k) => k.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(k.toLowerCase())));
    // Mismo encabezado y mismo documento que la pasada de coherencia, y en el
    // mismo orden: si el documento no cambió, esta llamada lo lee de caché
    // entero. Las instrucciones van al final, que además es donde mejor se
    // siguen cuando arriba hay cien mil caracteres de texto.
    const encabezado = encabezadoConDocumento(plan.secciones, doc);
    const indicaciones = [
      bloqueAsuntoParaPrompt(ctx.asunto),
      `## Relectura final de «${plan.titulo}» (${plan.tipo}) antes de entregarlo al cliente`,
      "Revisa y reporta observaciones por sección, con gravedad alta (no se puede entregar así), media (conviene corregir) o baja (mecánico):",
      "1. Partes e identificadores: nombres, carácter, RFC, CURP, domicilios y representantes coinciden con el asunto; ninguna parte inventada o sin verificar usada como si lo estuviera.",
      "2. Objetivo, alcance y decisiones del abogado: el documento hace lo que se pidió y respeta cada decisión.",
      "3. Contenido obligatorio para este tipo de documento en México (cláusulas o apartados que faltan; requisitos de forma).",
      "4. Coherencia: términos definidos, referencias cruzadas, numeración, montos y fechas iguales en todo el texto, contradicciones.",
      "5. Datos pendientes [___] y cómo obtenerlos.",
      `6. Citas normativas: estas no fueron devueltas por la base y hay que verificarlas o quitarlas: ${citasNoVerificables.length ? citasNoVerificables.join("; ") : "ninguna"}.`,
      "7. Riesgos para nuestro cliente que el abogado deba ver antes de firmar o presentar.",
      'Responde SOLO con JSON: {"observaciones":[{"seccion":<n o null>,"gravedad":"alta|media|baja","texto":"…"}],"correcciones":[{"n":<sección>,"markdown":"<texto completo corregido, sólo para lo mecánico: numeración, referencias, erratas>"}],"listo":<true si no hay observaciones altas>}',
    ].join("\n");
    const out = await llamar(ctx.anthropic, {
      system: "Eres el socio que relee antes de entregar. Exigente, concreto, sin cortesía. Respondes con JSON.",
      user: [{ texto: encabezado, cachear: true }, { texto: indicaciones }],
      maxTokens: 12_000,
      cost,
      subtipo: "ai.juridico.revision",
    });
    const r = json<{ observaciones: Observacion[]; correcciones: { n: number; markdown: string }[]; listo: boolean }>(out, "{", "}");
    const observaciones: Observacion[] = (r?.observaciones ?? []).filter((o) => o && typeof o.texto === "string").map((o) => ({ seccion: typeof o.seccion === "number" ? o.seccion : undefined, gravedad: (["alta", "media", "baja"].includes(o.gravedad) ? o.gravedad : "media") as Observacion["gravedad"], texto: o.texto.slice(0, 600) })).slice(0, 40);
    for (const c of citasNoVerificables) observaciones.push({ gravedad: "alta", texto: `Cita no verificable en la base: ${c}. Verifícala o quítala.` });
    const ap = aplicarCorrecciones(plan, r?.correcciones ?? []);
    const listo = observaciones.every((o) => o.gravedad !== "alta");
    const revision: Revision = { fecha: new Date().toISOString(), observaciones, citasNoVerificables, listo, modelo: MODELO };
    const g = await guardar(docId, ctx, ap.plan, listo ? "revisado" : "borrador", { revision, motivoVersion: ap.aplicadas ? "revisión" : undefined });
    ctx.emitir({ type: "documento", documento: g.resumen });
    return {
      salida: JSON.stringify({ documento_id: docId, listo, observaciones, correcciones_aplicadas: ap.aplicadas, instruccion: listo ? "Sin observaciones altas: el documento queda «revisado». Dile al usuario qué observaciones medias/bajas quedan (ya las ve en el panel) y que está listo para su revisión final." : "Hay observaciones altas: NO está listo. Resúmelas al usuario y propón cómo resolverlas (editar_seccion, preguntar datos, registrar partes).", resumen: `${observaciones.length} observaciones · ${listo ? "revisado" : "con pendientes altos"}` }),
      documento: g.resumen,
      cargado: g.cargado,
    };
  }

  if (nombre === "editar_seccion") {
    const ref = typeof input.seccion === "number" ? input.seccion : String(input.seccion ?? "");
    const s = buscarSeccion(plan, ref);
    if (!s) return { salida: JSON.stringify({ error: `No encuentro la sección «${ref}». Secciones: ${plan.secciones.map((x) => `${x.n} ${x.titulo}`).join(" · ")}`, resumen: "sección no encontrada" }) };
    const instrucciones = typeof input.instrucciones === "string" ? input.instrucciones : "";
    ctx.emitir({ type: "documento_progreso", documento_id: docId, seccion: s.n, de: plan.secciones.length, titulo: s.titulo, hechas: 0, total: 1 });
    const r = await redactarSeccion(ctx.anthropic, plan, s, ctx.asunto, cost, `${instrucciones}\n\nTexto actual de la sección (cámbialo según las instrucciones, conserva lo demás):\n${s.markdown ?? "(sin redactar)"}`);
    s.markdown = r.markdown;
    s.fundamentos = [...new Set([...(s.fundamentos ?? []), ...r.citas])];
    const g = await guardar(docId, ctx, plan, "borrador", { revision: null, motivoVersion: `editar sección ${s.n}: ${instrucciones.slice(0, 80)}` });
    ctx.emitir({ type: "documento", documento: g.resumen });
    return { salida: JSON.stringify({ documento_id: docId, seccion: s.n, titulo: s.titulo, instruccion: "Sección reescrita y versión anterior guardada; el documento vuelve a «borrador»: si va a entregarse, revisar_documento de nuevo. Al usuario: qué cambió, en dos líneas.", resumen: `sección ${s.n} editada` }), documento: g.resumen, cargado: g.cargado };
  }

  return { salida: JSON.stringify({ error: `Herramienta desconocida: ${nombre}` }) };
}
