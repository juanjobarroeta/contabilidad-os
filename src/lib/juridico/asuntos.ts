// ─────────────────────────────────────────────────────────────────────────────
// El ASUNTO: la fuente de verdad de un caso para el copiloto jurídico.
//
// Partes (con RFC, CURP, domicilio, representante), expediente, autoridad, vía,
// objetivo y las decisiones que el abogado toma en el chat viven en la base,
// no en la memoria de la conversación. Cada turno recibe el asunto en el
// system prompt (bloqueAsuntoParaPrompt); el modelo lo alimenta con
// registrar_partes / actualizar_asunto y lo consulta con consultar_asunto; al
// subir un documento, extraerDatosDeDocumento propone partes y expediente
// (fuente «documento», sin verificar) para que el abogado los confirme.
//
// Lo puro (bloque del prompt, normalización, fusión de partes) se prueba en
// asuntos.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordLlmCost, type CostCtx } from "@/lib/costos/record";

export interface Parte {
  id?: string;
  rol: string;
  tipoPersona: "fisica" | "moral";
  nombre: string;
  rfc?: string | null;
  curp?: string | null;
  domicilio?: string | null;
  representante?: string | null;
  email?: string | null;
  telefono?: string | null;
  notas?: string | null;
  fuente: "chat" | "documento" | "manual";
  documentoId?: string | null;
  verificado: boolean;
}

export interface Decision {
  texto: string;
  mensajeId?: string | null;
  fecha: string;
}

export interface Asunto {
  id: string;
  titulo: string;
  materia: string | null;
  via: string | null;
  autoridad: string | null;
  expediente: string | null;
  entidad: string | null;
  cliente: string | null;
  objetivo: string | null;
  decisiones: Decision[];
  partes: Parte[];
}

const MAX_DECISIONES = 60;
const MAX_PARTES = 40;

// ── Normalización y fusión ───────────────────────────────────────────────────

export function normalizarNombre(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(s\.?a\.? de c\.?v\.?|s\.? de r\.?l\.?|sapi de cv|s\.?c\.?|a\.?c\.?)\b/g, " ")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizarRfc(s: string | null | undefined): string | null {
  const r = (s ?? "").toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "");
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(r) ? r : null;
}

export function normalizarCurp(s: string | null | undefined): string | null {
  const c = (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(c) ? c : null;
}

/** Misma persona: mismo RFC, misma CURP, o mismo nombre normalizado. */
export function mismaParte(a: Pick<Parte, "nombre" | "rfc" | "curp">, b: Pick<Parte, "nombre" | "rfc" | "curp">): boolean {
  const ra = normalizarRfc(a.rfc);
  const rb = normalizarRfc(b.rfc);
  if (ra && rb) return ra === rb;
  const ca = normalizarCurp(a.curp);
  const cb = normalizarCurp(b.curp);
  if (ca && cb) return ca === cb;
  return normalizarNombre(a.nombre) === normalizarNombre(b.nombre);
}

/**
 * Fusiona una parte nueva sobre una existente: lo verificado a mano no se
 * pisa; lo demás se completa con lo que llega (sin borrar datos con vacíos).
 */
export function fusionarParte(existente: Parte, nueva: Partial<Parte>): Parte {
  if (existente.verificado && existente.fuente === "manual") {
    // Sólo se rellenan huecos.
    const out = { ...existente };
    for (const k of ["rfc", "curp", "domicilio", "representante", "email", "telefono", "notas"] as const) {
      if (!out[k] && nueva[k]) out[k] = nueva[k] ?? null;
    }
    return out;
  }
  const out: Parte = { ...existente };
  for (const k of ["rol", "tipoPersona", "nombre", "rfc", "curp", "domicilio", "representante", "email", "telefono", "notas", "documentoId"] as const) {
    const v = nueva[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (nueva.fuente) out.fuente = nueva.fuente;
  out.rfc = normalizarRfc(out.rfc) ?? out.rfc ?? null;
  out.curp = normalizarCurp(out.curp) ?? out.curp ?? null;
  return out;
}

// ── Persistencia ─────────────────────────────────────────────────────────────

const selectAsunto = {
  id: true,
  titulo: true,
  materia: true,
  via: true,
  autoridad: true,
  expediente: true,
  entidad: true,
  cliente: true,
  objetivo: true,
  decisiones: true,
  partes: { orderBy: { createdAt: "asc" as const }, select: { id: true, rol: true, tipoPersona: true, nombre: true, rfc: true, curp: true, domicilio: true, representante: true, email: true, telefono: true, notas: true, fuente: true, documentoId: true, verificado: true } },
} satisfies Prisma.JuridicoAsuntoSelect;

type AsuntoRow = Prisma.JuridicoAsuntoGetPayload<{ select: typeof selectAsunto }>;

function aAsunto(r: AsuntoRow): Asunto {
  return {
    ...r,
    decisiones: ((r.decisiones as unknown as Decision[] | null) ?? []).filter((d) => d && typeof d.texto === "string"),
    partes: r.partes.map((p) => ({ ...p, tipoPersona: p.tipoPersona === "moral" ? "moral" : "fisica", fuente: (["chat", "documento", "manual"].includes(p.fuente) ? p.fuente : "chat") as Parte["fuente"] })),
  };
}

export async function cargarAsunto(id: string, userId: string): Promise<Asunto | null> {
  const r = await prisma.juridicoAsunto.findFirst({ where: { id, userId }, select: selectAsunto });
  return r ? aAsunto(r) : null;
}

/** El asunto de una conversación; se crea al primer uso con el título de la conversación. */
export async function asuntoDeConversacion(conversacionId: string, userId: string, opts: { crear?: boolean } = {}): Promise<Asunto | null> {
  const conv = await prisma.juridicoConversacion.findFirst({ where: { id: conversacionId, userId }, select: { asuntoId: true, titulo: true } });
  if (!conv) return null;
  if (conv.asuntoId) {
    const a = await cargarAsunto(conv.asuntoId, userId);
    if (a) return a;
  }
  if (!opts.crear) return null;
  const creado = await prisma.juridicoAsunto.create({ data: { userId, titulo: conv.titulo.slice(0, 120) || "Asunto" }, select: selectAsunto });
  await prisma.juridicoConversacion.update({ where: { id: conversacionId }, data: { asuntoId: creado.id } });
  return aAsunto(creado);
}

/** Registra o actualiza partes (fusionando por RFC/CURP/nombre). Devuelve el asunto actualizado. */
export async function registrarPartes(asuntoId: string, userId: string, nuevas: Partial<Parte>[]): Promise<{ asunto: Asunto; creadas: number; actualizadas: number }> {
  const asunto = await cargarAsunto(asuntoId, userId);
  if (!asunto) throw new Error("Asunto no encontrado");
  let creadas = 0;
  let actualizadas = 0;
  for (const n of nuevas) {
    if (!n.nombre || !n.nombre.trim()) continue;
    const existente = asunto.partes.find((p) => mismaParte(p, { nombre: n.nombre!, rfc: n.rfc, curp: n.curp }));
    if (existente) {
      const f = fusionarParte(existente, n);
      await prisma.juridicoParte.update({ where: { id: existente.id! }, data: { rol: f.rol, tipoPersona: f.tipoPersona, nombre: f.nombre, rfc: f.rfc, curp: f.curp, domicilio: f.domicilio, representante: f.representante, email: f.email, telefono: f.telefono, notas: f.notas, fuente: f.fuente, documentoId: f.documentoId ?? null } });
      Object.assign(existente, f);
      actualizadas++;
    } else {
      if (asunto.partes.length >= MAX_PARTES) break;
      const creada = await prisma.juridicoParte.create({
        data: {
          asuntoId,
          rol: (n.rol ?? "parte").slice(0, 60),
          tipoPersona: n.tipoPersona === "moral" ? "moral" : "fisica",
          nombre: n.nombre.trim().slice(0, 200),
          rfc: normalizarRfc(n.rfc) ?? (n.rfc ?? null),
          curp: normalizarCurp(n.curp) ?? (n.curp ?? null),
          domicilio: n.domicilio ?? null,
          representante: n.representante ?? null,
          email: n.email ?? null,
          telefono: n.telefono ?? null,
          notas: n.notas ?? null,
          fuente: n.fuente ?? "chat",
          documentoId: n.documentoId ?? null,
          verificado: n.fuente === "manual" ? true : false,
        },
      });
      asunto.partes.push({ ...creada, tipoPersona: creada.tipoPersona as Parte["tipoPersona"], fuente: creada.fuente as Parte["fuente"] });
      creadas++;
    }
  }
  await prisma.juridicoAsunto.update({ where: { id: asuntoId }, data: { updatedAt: new Date() } });
  return { asunto: (await cargarAsunto(asuntoId, userId))!, creadas, actualizadas };
}

export async function actualizarAsunto(
  asuntoId: string,
  userId: string,
  cambios: Partial<Pick<Asunto, "titulo" | "materia" | "via" | "autoridad" | "expediente" | "entidad" | "cliente" | "objetivo">> & { decision?: string; mensajeId?: string | null }
): Promise<Asunto> {
  const actual = await cargarAsunto(asuntoId, userId);
  if (!actual) throw new Error("Asunto no encontrado");
  const data: Prisma.JuridicoAsuntoUpdateInput = {};
  for (const k of ["titulo", "materia", "via", "autoridad", "expediente", "entidad", "cliente", "objetivo"] as const) {
    const v = cambios[k];
    if (typeof v === "string" && v.trim()) data[k] = v.trim().slice(0, k === "objetivo" ? 4000 : 200);
  }
  if (cambios.decision && cambios.decision.trim()) {
    const decisiones = [...actual.decisiones, { texto: cambios.decision.trim().slice(0, 600), mensajeId: cambios.mensajeId ?? null, fecha: new Date().toISOString().slice(0, 10) }].slice(-MAX_DECISIONES);
    data.decisiones = decisiones as unknown as Prisma.InputJsonValue;
  }
  const r = await prisma.juridicoAsunto.update({ where: { id: asuntoId }, data, select: selectAsunto });
  return aAsunto(r);
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function bloqueAsuntoParaPrompt(a: Asunto | null): string {
  const l: string[] = ["## Asunto (fuente de verdad: base de datos, no tu memoria)", ""];
  if (!a) {
    l.push("Esta conversación aún no tiene asunto registrado. En cuanto sepas quiénes son las partes, el expediente, la autoridad o el objetivo, regístralos con registrar_partes / actualizar_asunto; el registro crea el asunto.", "");
  } else {
    l.push(`- **${a.titulo}**${a.expediente ? ` · expediente ${a.expediente}` : ""}${a.autoridad ? ` · ${a.autoridad}` : ""}${a.entidad ? ` · ${a.entidad}` : ""}`);
    if (a.materia || a.via) l.push(`- Materia/vía: ${[a.materia, a.via].filter(Boolean).join(" · ")}`);
    if (a.cliente) l.push(`- Nuestro cliente es: ${a.cliente}`);
    if (a.objetivo) l.push(`- Objetivo y alcance: ${a.objetivo}`);
    if (a.partes.length) {
      l.push("- Partes:");
      for (const p of a.partes) {
        const datos = [p.tipoPersona === "moral" ? "persona moral" : "persona física", p.rfc ? `RFC ${p.rfc}` : null, p.curp ? `CURP ${p.curp}` : null, p.representante ? `rep. ${p.representante}` : null, p.domicilio ? `dom. ${p.domicilio}` : null].filter(Boolean).join(", ");
        l.push(`  - ${p.rol}: **${p.nombre}** (${datos})${p.verificado ? "" : " — sin verificar por el abogado"}`);
      }
    } else l.push("- Partes: ninguna registrada todavía.");
    if (a.decisiones.length) {
      l.push("- Decisiones e instrucciones del abogado (obligan a lo que redactes):");
      for (const d of a.decisiones.slice(-25)) l.push(`  - [${d.fecha}] ${d.texto}`);
    }
    l.push("");
  }
  l.push(
    "### Reglas del asunto",
    "- Nombres, RFC, CURP, domicilios, representantes, expediente y autoridad salen de aquí. Si un dato falta, pregúntalo o deja [___]; NUNCA lo inventes ni lo completes de memoria.",
    "- Cuando el usuario te dé una parte o un dato nuevo, o subas uno de un documento, regístralo con registrar_partes (fuente «chat» o «documento»). Cuando decida algo sobre el asunto («sin reconvención», «jurisdicción Puebla», «tasa 12 %»), guárdalo con actualizar_asunto({ decision }).",
    "- Una parte «sin verificar» viene de un documento o del chat sin confirmación: úsala, pero dilo si redactas con ella.",
    ""
  );
  return l.join("\n");
}

// ── Herramientas ─────────────────────────────────────────────────────────────

export const toolsAsunto: Anthropic.Tool[] = [
  {
    name: "registrar_partes",
    description:
      "Registra o actualiza las PARTES del asunto en la base de datos (actor, demandado, cliente, contraparte, mutuante, mutuario, arrendador, arrendatario, testigo…). Úsala en cuanto sepas quién es quién —por el usuario o por un documento adjunto— y cada vez que aparezca un dato nuevo (RFC, CURP, domicilio, representante). Se fusiona por RFC/CURP/nombre; no crea duplicados. Lo que registres queda «sin verificar» hasta que el abogado lo confirme en el panel.",
    input_schema: {
      type: "object",
      properties: {
        partes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rol: { type: "string", description: "actor | demandado | cliente | contraparte | mutuante | mutuario | arrendador | arrendatario | prestador | testigo | apoderado | otro" },
              tipoPersona: { type: "string", enum: ["fisica", "moral"] },
              nombre: { type: "string", description: "Nombre completo o razón social, tal como aparece en el documento." },
              rfc: { type: "string" },
              curp: { type: "string" },
              domicilio: { type: "string" },
              representante: { type: "string", description: "Quien firma por una persona moral o un apoderado." },
              email: { type: "string" },
              telefono: { type: "string" },
              notas: { type: "string", description: "Lo relevante que no cabe arriba: nacionalidad, estado civil, carácter con que comparece…" },
              fuente: { type: "string", enum: ["chat", "documento"], description: "De dónde sale el dato." },
              documento_id: { type: "string", description: "Si sale de un documento adjunto, su id." },
            },
            required: ["rol", "nombre"],
          },
        },
      },
      required: ["partes"],
    },
  },
  {
    name: "actualizar_asunto",
    description:
      "Actualiza los datos del asunto (título, materia, vía, autoridad, expediente, entidad, quién es nuestro cliente, objetivo/alcance) o guarda una DECISIÓN del abogado. Guarda como decisión toda instrucción que deba respetarse al redactar o al aconsejar: «no reconvenir», «jurisdicción en Puebla», «interés del 12 % anual», «el cliente no quiere litigar, sólo negociar». Una decisión por llamada, con sus propias palabras.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        materia: { type: "string" },
        via: { type: "string" },
        autoridad: { type: "string" },
        expediente: { type: "string" },
        entidad: { type: "string", description: "Clave SAT de la entidad: PUE, CHH, CMX…" },
        cliente: { type: "string", description: "Rol de nuestro cliente en el asunto (actor, demandado, mutuante…) y su nombre." },
        objetivo: { type: "string", description: "Qué se busca obtener y el alcance del encargo, en 1–4 líneas." },
        decision: { type: "string", description: "Una decisión o instrucción del abogado, textual y completa." },
      },
    },
  },
  {
    name: "consultar_asunto",
    description: "Devuelve el asunto completo desde la base de datos: partes con todos sus datos, expediente, autoridad, objetivo y decisiones. Úsala antes de redactar cualquier documento y cuando necesites un dato de una parte.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function ejecutarHerramientaAsunto(
  nombre: string,
  input: Record<string, unknown>,
  ctx: { userId: string; conversacionId: string; mensajeId?: string | null }
): Promise<{ salida: string; asunto: Asunto | null }> {
  if (nombre === "consultar_asunto") {
    const a = await asuntoDeConversacion(ctx.conversacionId, ctx.userId);
    return { salida: JSON.stringify(a ? { ...a, resumen: `${a.partes.length} partes, ${a.decisiones.length} decisiones` } : { aviso: "La conversación no tiene asunto todavía: regístralo con registrar_partes o actualizar_asunto.", resumen: "sin asunto" }), asunto: a };
  }
  if (nombre === "registrar_partes") {
    const a = await asuntoDeConversacion(ctx.conversacionId, ctx.userId, { crear: true });
    if (!a) return { salida: JSON.stringify({ error: "Conversación no encontrada" }), asunto: null };
    const partes = Array.isArray(input.partes) ? (input.partes as Record<string, unknown>[]) : [];
    const limpias: Partial<Parte>[] = partes.map((p) => ({
      rol: String(p.rol ?? "parte"),
      tipoPersona: p.tipoPersona === "moral" ? "moral" : "fisica",
      nombre: String(p.nombre ?? ""),
      rfc: typeof p.rfc === "string" ? p.rfc : undefined,
      curp: typeof p.curp === "string" ? p.curp : undefined,
      domicilio: typeof p.domicilio === "string" ? p.domicilio : undefined,
      representante: typeof p.representante === "string" ? p.representante : undefined,
      email: typeof p.email === "string" ? p.email : undefined,
      telefono: typeof p.telefono === "string" ? p.telefono : undefined,
      notas: typeof p.notas === "string" ? p.notas : undefined,
      fuente: p.fuente === "documento" ? "documento" : "chat",
      documentoId: typeof p.documento_id === "string" ? p.documento_id : undefined,
    }));
    const r = await registrarPartes(a.id, ctx.userId, limpias);
    return { salida: JSON.stringify({ asunto_id: a.id, creadas: r.creadas, actualizadas: r.actualizadas, partes: r.asunto.partes.map((p) => ({ id: p.id, rol: p.rol, nombre: p.nombre, rfc: p.rfc, verificado: p.verificado })), resumen: `${r.creadas} nuevas, ${r.actualizadas} actualizadas` }), asunto: r.asunto };
  }
  if (nombre === "actualizar_asunto") {
    const a = await asuntoDeConversacion(ctx.conversacionId, ctx.userId, { crear: true });
    if (!a) return { salida: JSON.stringify({ error: "Conversación no encontrada" }), asunto: null };
    const str = (k: string) => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : undefined);
    const r = await actualizarAsunto(a.id, ctx.userId, { titulo: str("titulo"), materia: str("materia"), via: str("via"), autoridad: str("autoridad"), expediente: str("expediente"), entidad: str("entidad"), cliente: str("cliente"), objetivo: str("objetivo"), decision: str("decision"), mensajeId: ctx.mensajeId ?? null });
    return { salida: JSON.stringify({ asunto_id: r.id, decisiones: r.decisiones.length, resumen: str("decision") ? `decisión guardada (${r.decisiones.length})` : "asunto actualizado" }), asunto: r };
  }
  return { salida: JSON.stringify({ error: `Herramienta de asunto desconocida: ${nombre}` }), asunto: null };
}

// ── Extracción desde un documento ────────────────────────────────────────────

const MODELO_EXTRACCION = process.env.AI_RESUMEN_MODEL ?? "claude-haiku-4-5-20251001";

export interface DatosExtraidos {
  partes: Partial<Parte>[];
  expediente?: string | null;
  autoridad?: string | null;
  materia?: string | null;
  via?: string | null;
  entidad?: string | null;
  tipoDocumento?: string | null;
}

/** Partes, expediente y autoridad que un documento declara (proemio, encabezado, comparecientes). Nunca inventa: si no está, no viene. */
export async function extraerDatosDeDocumento(anthropic: Anthropic, doc: { nombre: string; texto: string; id: string }, opts: { cost: CostCtx }): Promise<DatosExtraidos> {
  const muestra = doc.texto.length > 40_000 ? `${doc.texto.slice(0, 30_000)}\n[…]\n${doc.texto.slice(-8_000)}` : doc.texto;
  const res = await anthropic.messages.create({
    model: MODELO_EXTRACCION,
    max_tokens: 1_500,
    system: "Extraes datos de documentos jurídicos mexicanos. Sólo lo que el texto dice literalmente; nada inferido ni inventado. Respondes únicamente con JSON.",
    messages: [
      {
        role: "user",
        content: `Documento «${doc.nombre}». Extrae, si aparecen: las PARTES (cada una con rol —actor, demandado, mutuante, mutuario, arrendador, arrendatario, prestador, cliente, apoderado…—, tipoPersona fisica|moral, nombre completo tal cual, rfc, curp, domicilio, representante), el expediente, la autoridad (juzgado/tribunal), la materia, la vía o tipo de juicio, la entidad federativa (clave SAT: PUE, CHH, CMX, JAL…) y el tipo de documento (demanda, contestación, contrato, sentencia, acuerdo, pliego, otro).\nJSON: {"partes":[{"rol":"","tipoPersona":"fisica","nombre":"","rfc":null,"curp":null,"domicilio":null,"representante":null}],"expediente":null,"autoridad":null,"materia":null,"via":null,"entidad":null,"tipoDocumento":null}\n\n${muestra}`,
      },
    ],
  });
  await recordLlmCost(MODELO_EXTRACCION, res.usage, { ...opts.cost, subtipo: "ai.juridico.extraccion" });
  const texto = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");
  const json = texto.slice(texto.indexOf("{"), texto.lastIndexOf("}") + 1);
  try {
    const d = JSON.parse(json) as DatosExtraidos;
    const partes = (Array.isArray(d.partes) ? d.partes : [])
      .filter((p) => p && typeof p.nombre === "string" && p.nombre.trim().length > 2)
      .slice(0, 20)
      .map((p) => ({ ...p, rol: String(p.rol ?? "parte"), tipoPersona: p.tipoPersona === "moral" ? ("moral" as const) : ("fisica" as const), fuente: "documento" as const, documentoId: doc.id }));
    return { ...d, partes };
  } catch {
    return { partes: [] };
  }
}
