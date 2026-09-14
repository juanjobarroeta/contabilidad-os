import { TITULO_TEMA, tituloDeClave, type TemaExpediente } from "./claves";
import type { HechoExpediente } from "./hechos";
import type { NotaExpediente } from "./notas";

// ─────────────────────────────────────────────────────────────────────────────
// EL EXPEDIENTE, ESCRITO PARA EL MODELO. PURO — sin Prisma y sin reloj propio.
//
// Éste es el bloque que hace que el copiloto deje de ser genérico sin tocar el
// copiloto: hechos vigentes, compromisos abiertos y las últimas notas entran en
// el system prompt, igual que el bloque «Asunto» del copiloto jurídico (#1051).
//
// Dos decisiones que no son de estilo:
//
//   · Los PENDIENTES van ARRIBA de las notas y del historial. Lo que quedó
//     comprometido pesa más que lo que se observó, y si el modelo lo lee al
//     final ya gastó su atención en lo demás.
//   · Un hecho sin verificar se dice que no está verificado. Un expediente que
//     presenta una inferencia con el mismo tono que un dato confirmado enseña
//     al contador a desconfiar de todo, que es peor que no tenerlo.
// ─────────────────────────────────────────────────────────────────────────────

/** Cómo se lee un valor de hecho en una línea. PURA. */
export function valorEnTexto(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valorEnTexto).join(", ");
  const o = v as Record<string, unknown>;
  return Object.entries(o)
    .map(([k, x]) => `${k}: ${valorEnTexto(x)}`)
    .join("; ");
}

const fecha = (d: Date) =>
  new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);

/** Hace cuántos días, en palabras. PURA (`hoy` entra por parámetro). */
export function antiguedad(d: Date, hoy: Date): string {
  const dias = Math.floor((hoy.getTime() - d.getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 30) return `hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? "hace un mes" : `hace ${meses} meses`;
}

export interface Expediente {
  hechos: HechoExpediente[];
  pendientes: NotaExpediente[];
  notas: NotaExpediente[];
}

function lineaDeHecho(h: HechoExpediente): string {
  const marcas = [
    h.verificado ? null : "sin verificar",
    h.confianza === "baja" ? "confianza baja" : null,
    `desde ${fecha(h.vigenteDesde)}`,
  ].filter(Boolean);
  return `  - ${tituloDeClave(h.clave)}: **${valorEnTexto(h.valor)}** (${marcas.join(", ")})`;
}

function lineaDeNota(n: NotaExpediente, hoy: Date): string {
  return `  - [${TITULO_TEMA[n.tema as TemaExpediente] ?? n.tema} · ${antiguedad(n.createdAt, hoy)}] **${n.titulo}** — ${n.cuerpo.replace(/\s+/g, " ").slice(0, 220)}`;
}

/**
 * El bloque del expediente para el system prompt. PURO.
 *
 * Devuelve cadena vacía cuando no hay nada que contar: un bloque que sólo dice
 * «no hay expediente» gasta tokens en cada turno y no cambia una sola respuesta.
 */
export function bloqueExpedienteParaPrompt(e: Expediente, hoy: Date): string {
  const l: string[] = ["## Expediente de esta empresa (fuente de verdad: la base, no tu memoria)", ""];

  // Una empresa nueva no tiene expediente, y si por eso el bloque desapareciera
  // el modelo nunca sabría que puede escribirlo: el expediente no arrancaría
  // jamás. Cuesta unas líneas y es lo que lo pone en marcha.
  if (e.hechos.length === 0 && e.pendientes.length === 0 && e.notas.length === 0) {
    return [
      ...l,
      "Todavía no hay nada registrado de esta empresa.",
      "",
      "En cuanto sepas algo duradero del cliente —qué terminal tiene, quién lleva su cierre, a cuántos días le pagan, en qué moneda le facturan— guárdalo con registrar_hecho. Cuando revises algo, el usuario decida algo, o quede algo pendiente de él, escríbelo con anotar_expediente. Lo que no quede escrito se pierde en cuanto termine esta conversación.",
      "",
    ].join("\n");
  }

  if (e.pendientes.length > 0) {
    l.push("### Compromisos abiertos (léelos antes que nada)");
    for (const n of e.pendientes) l.push(lineaDeNota(n, hoy));
    l.push("");
  }

  if (e.hechos.length > 0) {
    l.push("### Lo que sabemos de este cliente");
    const porFamilia = new Map<string, HechoExpediente[]>();
    for (const h of e.hechos) porFamilia.set(h.familia, [...(porFamilia.get(h.familia) ?? []), h]);
    for (const [familia, hechos] of [...porFamilia.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      l.push(`- ${familia}:`);
      for (const h of hechos) l.push(lineaDeHecho(h));
    }
    l.push("");
  }

  if (e.notas.length > 0) {
    l.push("### Últimas notas de trabajo");
    for (const n of e.notas) l.push(lineaDeNota(n, hoy));
    l.push("");
  }

  l.push(
    "### Cómo usar el expediente",
    "- Lo de arriba es lo que YA se sabe y lo que YA se decidió. No vuelvas a reportar un problema sobre el que hay un compromiso abierto: di en qué va y qué falta para cerrarlo.",
    "- Un hecho «sin verificar» lo dedujo un motor o el agente: úsalo, pero dilo cuando construyas una conclusión encima.",
    "- Cuando aprendas algo duradero del cliente (una terminal, un plazo de pago, quién lleva el cierre), guárdalo con registrar_hecho. Cuando revises, decidas o dejes algo pendiente, escríbelo con anotar_expediente. Lo que no quede escrito se pierde entre corridas.",
    "- Un hecho NO se edita: si cambió, registra el valor nuevo y el sistema cierra el anterior solo.",
    "",
  );
  return l.join("\n");
}
