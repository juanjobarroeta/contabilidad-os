// ─────────────────────────────────────────────────────────────────────────────
// Versiones de un documento CON AUTOR.
//
// Antes vivían en JuridicoDocumento.versiones (un JSON con el texto anterior y
// nada más): no se sabía quién la hizo, cuándo ni por qué. Eso no sirve para
// explicarle a un cliente por qué cambió una cláusula, ni como evidencia si lo
// discute.
//
// Cada versión guarda autor (abogado, cliente o copiloto), motivo y qué
// secciones cambiaron. El cálculo del diff por sección es puro y se prueba
// aparte; la comparación completa la hace la UI (W-06).
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apuntar, type Actor, type ActorTipo } from "./bitacora";

export interface Version {
  id: string;
  n: number;
  autorUserId: string | null;
  autorTipo: ActorTipo;
  autorNombre: string | null;
  motivo: string | null;
  seccionesCambiadas: { n: number; titulo: string; cambio: "agregada" | "editada" | "eliminada" }[];
  caracteres: number;
  createdAt: Date;
}

export interface SeccionComparable {
  n: number;
  titulo: string;
  markdown?: string;
}

/**
 * Qué secciones cambiaron entre dos planes. Puro. Compara por número de
 * sección (que es lo estable en redaccion-estructurada.ts) y sólo mira el
 * markdown; cambiar el título cuenta como edición.
 */
export function seccionesCambiadas(antes: SeccionComparable[] | null | undefined, despues: SeccionComparable[] | null | undefined): { n: number; titulo: string; cambio: "agregada" | "editada" | "eliminada" }[] {
  const a = new Map((antes ?? []).map((s) => [s.n, s]));
  const d = new Map((despues ?? []).map((s) => [s.n, s]));
  const out: { n: number; titulo: string; cambio: "agregada" | "editada" | "eliminada" }[] = [];
  for (const [n, s] of d) {
    const previa = a.get(n);
    if (!previa) out.push({ n, titulo: s.titulo, cambio: "agregada" });
    else if ((previa.markdown ?? "") !== (s.markdown ?? "") || previa.titulo !== s.titulo) out.push({ n, titulo: s.titulo, cambio: "editada" });
  }
  for (const [n, s] of a) if (!d.has(n)) out.push({ n, titulo: s.titulo, cambio: "eliminada" });
  return out.sort((x, y) => x.n - y.n);
}

/** Una línea para la bitácora: «v3: editó 2 secciones (TERCERA.- RENTA, …)». Pura. */
export function resumenDeVersion(n: number, cambios: { titulo: string; cambio: string }[], motivo?: string | null): string {
  if (cambios.length === 0) return `guardó la versión ${n}${motivo ? ` (${motivo})` : ""}`;
  const nombres = cambios.slice(0, 3).map((c) => c.titulo).join(", ");
  const resto = cambios.length > 3 ? ` y ${cambios.length - 3} más` : "";
  return `guardó la versión ${n}: ${cambios.length} sección${cambios.length === 1 ? "" : "es"} (${nombres}${resto})${motivo ? ` — ${motivo}` : ""}`;
}

/**
 * Congela el estado ACTUAL del documento como una versión nueva. Se llama
 * ANTES de sobrescribirlo, que es cuando el texto anterior todavía existe.
 */
export async function guardarVersion(args: {
  documentoId: string;
  texto: string;
  plan?: unknown;
  actor: Actor;
  motivo?: string | null;
  planNuevo?: unknown;
  casoId?: string | null;
}): Promise<Version | null> {
  const ultima = await prisma.juridicoDocumentoVersion.findFirst({ where: { documentoId: args.documentoId }, orderBy: { n: "desc" }, select: { n: true } });
  const n = (ultima?.n ?? 0) + 1;
  const secciones = (p: unknown) => ((p as { secciones?: SeccionComparable[] } | null)?.secciones ?? []) as SeccionComparable[];
  const cambios = args.planNuevo === undefined ? [] : seccionesCambiadas(secciones(args.plan), secciones(args.planNuevo));
  try {
    const f = await prisma.juridicoDocumentoVersion.create({
      data: {
        documentoId: args.documentoId,
        n,
        texto: args.texto,
        plan: args.plan === undefined || args.plan === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(args.plan)) as Prisma.InputJsonValue),
        autorUserId: args.actor.userId ?? null,
        autorTipo: args.actor.tipo ?? "abogado",
        autorNombre: args.actor.nombre ?? null,
        motivo: args.motivo ?? null,
        seccionesCambiadas: cambios as unknown as Prisma.InputJsonValue,
      },
    });
    if (args.casoId) {
      await apuntar({ casoId: args.casoId, actor: args.actor, accion: "documento.version", entidad: "documento", entidadId: args.documentoId, resumen: resumenDeVersion(n, cambios, args.motivo), datos: { version: n, cambios } });
    }
    return {
      id: f.id,
      n: f.n,
      autorUserId: f.autorUserId,
      autorTipo: f.autorTipo as ActorTipo,
      autorNombre: f.autorNombre,
      motivo: f.motivo,
      seccionesCambiadas: cambios,
      caracteres: f.texto.length,
      createdAt: f.createdAt,
    };
  } catch {
    // Una versión perdida no puede tumbar el guardado del documento.
    return null;
  }
}

/** El historial (sin los textos: pesan). */
export async function listarVersiones(documentoId: string): Promise<Version[]> {
  const filas = await prisma.juridicoDocumentoVersion.findMany({ where: { documentoId }, orderBy: { n: "desc" }, select: { id: true, n: true, autorUserId: true, autorTipo: true, autorNombre: true, motivo: true, seccionesCambiadas: true, createdAt: true, texto: true } });
  return filas.map((f) => ({
    id: f.id,
    n: f.n,
    autorUserId: f.autorUserId,
    autorTipo: f.autorTipo as ActorTipo,
    autorNombre: f.autorNombre,
    motivo: f.motivo,
    seccionesCambiadas: (f.seccionesCambiadas as unknown as Version["seccionesCambiadas"]) ?? [],
    caracteres: f.texto.length,
    createdAt: f.createdAt,
  }));
}

/** El texto de una versión, para comparar o restaurar. */
export async function leerVersion(documentoId: string, n: number): Promise<{ texto: string; plan: unknown } | null> {
  const f = await prisma.juridicoDocumentoVersion.findUnique({ where: { documentoId_n: { documentoId, n } }, select: { texto: true, plan: true } });
  return f ? { texto: f.texto, plan: f.plan ?? null } : null;
}
