import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  familiaDeClave,
  tituloDeClave,
  type Confianza,
  type FuenteExpediente,
} from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// LOS HECHOS DEL EXPEDIENTE — lo que es cierto de esta empresa, con su fecha.
//
// La regla que gobierna todo el módulo: un hecho NO se edita. Cuando cambia, el
// vigente se cierra con `vigenteHasta` y se abre otro. Sobreescribir sería más
// corto y borraría la única respuesta a «¿desde cuándo?», que es la pregunta
// que aparece en cuanto un cargo no cuadra con el contrato.
//
// La segunda regla la copiamos del copiloto jurídico (#1051): lo que una
// PERSONA verificó no lo pisa ni el motor ni el agente. Un dato confirmado a
// mano vale más que una inferencia, por buena que sea, y si el motor pudiera
// sobrescribirlo el contador dejaría de confiar en la tabla — que es la única
// forma de que una memoria compartida funcione.
// ─────────────────────────────────────────────────────────────────────────────

export interface HechoExpediente {
  id: string;
  clave: string;
  titulo: string;
  familia: string;
  valor: unknown;
  fuente: FuenteExpediente;
  evidencia: string[];
  vigenteDesde: Date;
  vigenteHasta: Date | null;
  confianza: Confianza;
  verificado: boolean;
}

/** Cuántos hechos vigentes se traen para el bloque del prompt. */
export const MAX_HECHOS_PROMPT = 40;

/**
 * ¿Son el mismo valor? PURA.
 *
 * Comparación estructural con claves ordenadas: sin esto, `{a:1,b:2}` y
 * `{b:2,a:1}` se verían distintos y cada corrida cerraría y reabriría el mismo
 * hecho, llenando la tabla de versiones idénticas con fechas distintas —
 * exactamente el ruido que el expediente existe para evitar.
 */
export function mismoValor(a: unknown, b: unknown): boolean {
  return estable(a) === estable(b);
}

function estable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(estable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${estable(o[k])}`)
    .join(",")}}`;
}

export interface DecisionDeEscritura {
  /** Qué hacer con lo que ya había. */
  accion: "crear" | "reemplazar" | "enriquecer" | "ignorar";
  motivo: string;
}

/**
 * Qué hacer con un hecho nuevo frente al vigente. PURA.
 *
 * Se separa de la escritura para poder probar las reglas —que son las que
 * deciden si el contador confía en el expediente— sin base de datos.
 */
export function decidirEscritura(
  vigente: Pick<HechoExpediente, "valor" | "verificado" | "fuente" | "evidencia"> | null,
  nuevo: { valor: unknown; fuente: FuenteExpediente; evidencia?: string[] },
): DecisionDeEscritura {
  if (!vigente) return { accion: "crear", motivo: "No había nada registrado bajo esta clave." };

  if (mismoValor(vigente.valor, nuevo.valor)) {
    // Mismo valor: no se abre una versión, pero la evidencia nueva sí suma —
    // un hecho respaldado por tres corridas vale más que uno respaldado por una.
    const nuevas = (nuevo.evidencia ?? []).filter((e) => !vigente.evidencia.includes(e));
    return nuevas.length > 0
      ? { accion: "enriquecer", motivo: "El valor no cambió; se agrega la evidencia nueva." }
      : { accion: "ignorar", motivo: "Ya estaba registrado igual, con la misma evidencia." };
  }

  if (vigente.verificado && nuevo.fuente !== "usuario") {
    return {
      accion: "ignorar",
      motivo: "Una persona verificó este hecho a mano: ni el motor ni el agente lo cambian.",
    };
  }

  return { accion: "reemplazar", motivo: "El valor cambió: se cierra el anterior y se abre uno nuevo." };
}

function aHecho(r: {
  id: string;
  clave: string;
  valor: Prisma.JsonValue;
  fuente: string;
  evidencia: string[];
  vigenteDesde: Date;
  vigenteHasta: Date | null;
  confianza: string;
  verificado: boolean;
}): HechoExpediente {
  return {
    id: r.id,
    clave: r.clave,
    titulo: tituloDeClave(r.clave),
    familia: familiaDeClave(r.clave),
    valor: r.valor,
    fuente: (["motor", "agente", "usuario"].includes(r.fuente) ? r.fuente : "motor") as FuenteExpediente,
    evidencia: r.evidencia,
    vigenteDesde: r.vigenteDesde,
    vigenteHasta: r.vigenteHasta,
    confianza: (["alta", "media", "baja"].includes(r.confianza) ? r.confianza : "media") as Confianza,
    verificado: r.verificado,
  };
}

const SELECT_HECHO = {
  id: true,
  clave: true,
  valor: true,
  fuente: true,
  evidencia: true,
  vigenteDesde: true,
  vigenteHasta: true,
  confianza: true,
  verificado: true,
} satisfies Prisma.ExpedienteHechoSelect;

/** Los hechos vigentes hoy, ordenados por clave. */
export async function hechosVigentes(companyId: string, limite = 200): Promise<HechoExpediente[]> {
  const filas = await prisma.expedienteHecho.findMany({
    where: { companyId, vigenteHasta: null },
    orderBy: [{ clave: "asc" }, { vigenteDesde: "desc" }],
    take: limite,
    select: SELECT_HECHO,
  });
  return filas.map(aHecho);
}

/** Toda la historia de una clave, de lo más reciente a lo más viejo. */
export async function historiaDeClave(
  companyId: string,
  clave: string,
  limite = 50,
): Promise<HechoExpediente[]> {
  const filas = await prisma.expedienteHecho.findMany({
    where: { companyId, clave },
    orderBy: { vigenteDesde: "desc" },
    take: limite,
    select: SELECT_HECHO,
  });
  return filas.map(aHecho);
}

export interface EntradaHecho {
  companyId: string;
  clave: string;
  valor: unknown;
  fuente?: FuenteExpediente;
  evidencia?: string[];
  confianza?: Confianza;
  /** Sólo una persona puede marcar un hecho como verificado. */
  verificado?: boolean;
  /** Para pruebas y para reprocesos: la fecha desde la que rige. */
  desde?: Date;
}

export interface ResultadoEscritura {
  accion: DecisionDeEscritura["accion"];
  motivo: string;
  hecho: HechoExpediente | null;
}

/**
 * Registra un hecho aplicando las reglas de `decidirEscritura`.
 *
 * A diferencia del rastro de decisión, esto SÍ se espera: quien lo llama
 * necesita saber si el hecho quedó o si se respetó lo verificado a mano.
 */
export async function registrarHecho(e: EntradaHecho): Promise<ResultadoEscritura> {
  const fuente = e.fuente ?? "motor";
  const desde = e.desde ?? new Date();

  const previo = await prisma.expedienteHecho.findFirst({
    where: { companyId: e.companyId, clave: e.clave, vigenteHasta: null },
    orderBy: { vigenteDesde: "desc" },
    select: SELECT_HECHO,
  });
  const vigente = previo ? aHecho(previo) : null;
  const decision = decidirEscritura(vigente, { valor: e.valor, fuente, evidencia: e.evidencia });

  if (decision.accion === "ignorar") return { ...decision, hecho: vigente };

  if (decision.accion === "enriquecer" && previo) {
    const evidencia = [...new Set([...previo.evidencia, ...(e.evidencia ?? [])])];
    const fila = await prisma.expedienteHecho.update({
      where: { id: previo.id },
      data: { evidencia },
      select: SELECT_HECHO,
    });
    return { ...decision, hecho: aHecho(fila) };
  }

  // Cerrar y abrir, nunca sobreescribir. El cierre lleva la MISMA fecha con la
  // que abre el nuevo: si no, quedaría un hueco en el que el hecho no existió.
  if (decision.accion === "reemplazar" && previo) {
    await prisma.expedienteHecho.update({
      where: { id: previo.id },
      data: { vigenteHasta: desde },
    });
  }

  const fila = await prisma.expedienteHecho.create({
    data: {
      companyId: e.companyId,
      clave: e.clave,
      valor: (e.valor ?? null) as Prisma.InputJsonValue,
      fuente,
      evidencia: e.evidencia ?? [],
      confianza: e.confianza ?? "media",
      // Sólo una persona verifica. Un motor que se auto-certificara volvería
      // inmutable su propia inferencia y nadie podría corregirla después.
      verificado: fuente === "usuario" ? Boolean(e.verificado) : false,
      vigenteDesde: desde,
    },
    select: SELECT_HECHO,
  });
  return { ...decision, hecho: aHecho(fila) };
}

/** Marca un hecho como confirmado por una persona. Sólo lo llama la UI. */
export async function verificarHecho(
  companyId: string,
  hechoId: string,
  verificado: boolean,
): Promise<HechoExpediente | null> {
  const r = await prisma.expedienteHecho.updateMany({
    where: { id: hechoId, companyId },
    data: { verificado, confianza: verificado ? "alta" : undefined },
  });
  if (r.count === 0) return null;
  const fila = await prisma.expedienteHecho.findUnique({ where: { id: hechoId }, select: SELECT_HECHO });
  return fila ? aHecho(fila) : null;
}

/** Cierra un hecho vigente sin abrir otro: dejó de ser cierto y ya. */
export async function cerrarHecho(companyId: string, hechoId: string, cuando = new Date()): Promise<boolean> {
  const r = await prisma.expedienteHecho.updateMany({
    where: { id: hechoId, companyId, vigenteHasta: null },
    data: { vigenteHasta: cuando },
  });
  return r.count > 0;
}
