import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SyntageClient, SyntageError } from "./client";
import { backfillDeclaracionesMensuales } from "./declaraciones-backfill";
import { leerEImportarContabilidadElectronicaSyntage } from "@/lib/contabilidad/ce-import-syntage";

// ─────────────────────────────────────────────────────────────────────────────
// CIERRE DE SYNTAGE (oct-2026) — exportar todo y después borrar.
//
// Syntage no se vuelve a consultar una vez borradas las entidades, así que
// antes se guarda en `SyntageArchivo`, por RFC, TODO lo que tiene cada
// entidad: los registros JSON (opinión 32-D, CSF, declaraciones, contabilidad
// electrónica) y cada archivo que esos registros referencian (acuses, PDFs,
// XML de catálogo/balanza/pólizas). Encima, para las empresas que existen,
// se corre el gap-fill de declaraciones y la importación de la CE, que sólo
// LEEN lo ya extraído (no disparan extracciones nuevas).
//
// Una entidad por llamada, idempotente: lo ya archivado se salta (llave
// rfc+tipo+ref). La fila `export:completo` sólo se escribe si NO hubo un solo
// error; es la condición que exige el borrado. Los CFDI no se archivan: los
// trae nuestra propia descarga masiva del SAT.
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Recursos por entidad que se archivan completos. */
export const RECURSOS_ENTIDAD = [
  "tax-compliance-checks",
  "tax-status",
  "tax-returns",
  "electronic-accounting-records",
] as const;

export const TIPO_COMPLETO = "export:completo";
export const TIPO_INCOMPLETO = "export:incompleto";
export const TIPO_BORRADO = "borrado";

/** Id de una entidad (campo `id` o el final del IRI `@id`). */
export function idDeEntidad(e: Json): string {
  const id = e.id ?? String(e["@id"] ?? "").split("/").pop();
  return id ? String(id) : "";
}

/** RFC de una entidad, buscando en los campos donde Syntage lo pone. */
export function rfcDeEntidad(e: Json): string {
  const directo = e.rfc ?? (e.taxpayer as Json | undefined)?.rfc ?? (e.taxpayer as Json | undefined)?.id;
  if (typeof directo === "string" && directo.trim()) return directo.trim().toUpperCase();
  const m = /\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/.exec(JSON.stringify(e).toUpperCase());
  return m ? m[1] : "";
}

/**
 * Todas las referencias a archivos dentro de un JSON de Syntage (`/files/{id}`
 * en cualquier campo y a cualquier profundidad), sin repetir. Puro.
 */
export function refsDeArchivo(v: unknown, out = new Set<string>()): string[] {
  if (typeof v === "string") {
    const m = /\/files\/[A-Za-z0-9-]+/.exec(v);
    if (m) out.add(m[0]);
  } else if (Array.isArray(v)) {
    for (const x of v) refsDeArchivo(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) refsDeArchivo(x, out);
  }
  return [...out];
}

/** Nombre legible de un archivo a partir del registro que lo referencia. */
function nombreDeRef(registros: Json[], ref: string): string | null {
  for (const r of registros) {
    for (const f of (Array.isArray(r.files) ? r.files : [r.file]) as unknown[]) {
      if (!f || typeof f !== "object") continue;
      const fo = f as Json;
      if (String(fo["@id"] ?? fo.id ?? "").includes(ref.replace("/files/", "")) && typeof fo.filename === "string") return fo.filename;
    }
  }
  return null;
}

export interface ResultadoExportacion {
  rfc: string;
  entityId: string;
  companyId: string | null;
  registros: number;
  archivosNuevos: number;
  archivosYaGuardados: number;
  /** Archivos que Syntage ya no tiene (404): se anotan, no bloquean el borrado. */
  avisos: string[];
  /** Se cortó por tiempo: lo que falte se baja en la siguiente llamada. */
  cortado?: boolean;
  declaraciones?: { mesesCreados: number; acusesParseados: number; error?: string };
  ce?: { catalogo: boolean; balanza: boolean; error?: string };
  errores: string[];
}

async function guardar(fila: {
  rfc: string;
  companyId: string | null;
  entityId: string;
  tipo: string;
  ref: string;
  nombre?: string | null;
  contentType?: string | null;
  bytes?: Uint8Array<ArrayBuffer> | null;
  datos?: Prisma.InputJsonValue;
}) {
  await prisma.syntageArchivo.upsert({
    where: { rfc_tipo_ref: { rfc: fila.rfc, tipo: fila.tipo, ref: fila.ref } },
    create: { ...fila, nombre: fila.nombre ?? null, contentType: fila.contentType ?? null, bytes: fila.bytes ?? null },
    update: {
      companyId: fila.companyId,
      entityId: fila.entityId,
      ...(fila.datos !== undefined ? { datos: fila.datos } : {}),
      ...(fila.bytes ? { bytes: fila.bytes, contentType: fila.contentType ?? null, nombre: fila.nombre ?? null } : {}),
    },
  });
}

/** Exporta UNA entidad completa. Nunca lanza: los fallos quedan en `errores`. */
export async function exportarEntidad(
  client: SyntageClient,
  entidad: Json,
  opts: { hastaMs?: number } = {},
): Promise<ResultadoExportacion> {
  const hasta = opts.hastaMs ?? Number.POSITIVE_INFINITY;
  const entityId = idDeEntidad(entidad);
  const rfc = rfcDeEntidad(entidad) || `SIN-RFC-${entityId}`;
  const company = rfc.startsWith("SIN-RFC")
    ? null
    : await prisma.company.findFirst({ where: { rfc }, select: { id: true } });
  const companyId = company?.id ?? null;
  const r: ResultadoExportacion = { rfc, entityId, companyId, registros: 0, archivosNuevos: 0, archivosYaGuardados: 0, avisos: [], errores: [] };
  const base = { rfc, companyId, entityId };

  await guardar({ ...base, tipo: "json:entity", ref: `/entities/${entityId}`, datos: entidad as Prisma.InputJsonValue });

  // 1. Los registros de cada recurso, completos.
  const todos: Json[] = [entidad];
  for (const recurso of RECURSOS_ENTIDAD) {
    try {
      const lista = await client.listarColeccion(`/entities/${entityId}/${recurso}`);
      r.registros += lista.length;
      todos.push(...lista);
      await guardar({ ...base, tipo: `json:${recurso}`, ref: `/entities/${entityId}/${recurso}`, datos: lista as Prisma.InputJsonValue });
    } catch (e) {
      r.errores.push(`${recurso}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Cada archivo referenciado, una sola vez.
  const yaGuardados = new Set(
    (
      await prisma.syntageArchivo.findMany({
        where: { rfc, tipo: "archivo", bytes: { not: null } },
        select: { ref: true },
      })
    ).map((f) => f.ref),
  );
  for (const ref of refsDeArchivo(todos)) {
    if (yaGuardados.has(ref)) {
      r.archivosYaGuardados++;
      continue;
    }
    if (Date.now() > hasta) {
      r.cortado = true;
      break;
    }
    try {
      const f = await client.downloadAcuse(ref);
      await guardar({
        ...base,
        tipo: "archivo",
        ref,
        nombre: f.filename ?? nombreDeRef(todos, ref),
        contentType: f.contentType,
        bytes: new Uint8Array(f.data),
      });
      r.archivosNuevos++;
    } catch (e) {
      const msg = `archivo ${ref}: ${e instanceof Error ? e.message : String(e)}`;
      if (e instanceof SyntageError && e.status === 404) r.avisos.push(msg);
      else r.errores.push(msg);
    }
  }
  if (r.cortado) r.errores.push("cortado por tiempo: faltan archivos (sigue en la próxima llamada)");

  // 3. Lo que la app usa, a la base (sólo lectura de lo ya extraído). Va al
  // final y sólo con el archivo completo: el archivo es lo irrecuperable.
  if (companyId && !r.cortado) {
    try {
      const d = await backfillDeclaracionesMensuales(companyId, client, { maxAcuses: 50 });
      r.declaraciones = { mesesCreados: d.mesesCreados, acusesParseados: d.acusesParseados, ...(d.error ? { error: d.error } : {}) };
      if (d.error) r.errores.push(`declaraciones: ${d.error}`);
    } catch (e) {
      r.errores.push(`declaraciones: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const c = await leerEImportarContabilidadElectronicaSyntage(companyId, client);
      // Un plan sin Syntage o sin registros no es un error de exportación: los
      // XML ya quedaron en el archivo de todos modos.
      r.ce = { catalogo: !!c.catalogo, balanza: !!c.balanza, ...(c.error ? { error: c.error } : {}) };
    } catch (e) {
      r.ce = { catalogo: false, balanza: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 4. El veredicto: sólo un export sin errores habilita el borrado.
  const previo = await prisma.syntageArchivo.findFirst({ where: { rfc, tipo: TIPO_INCOMPLETO }, select: { datos: true } });
  const intentos = (Number((previo?.datos as { intentos?: unknown } | null)?.intentos) || 0) + (r.cortado ? 0 : 1);
  const resumen = { ...r, intentos, fecha: new Date().toISOString() } as unknown as Prisma.InputJsonValue;
  await prisma.syntageArchivo.deleteMany({ where: { rfc, tipo: { in: [TIPO_COMPLETO, TIPO_INCOMPLETO] } } });
  await guardar({ ...base, tipo: r.errores.length ? TIPO_INCOMPLETO : TIPO_COMPLETO, ref: `/entities/${entityId}`, datos: resumen });
  return r;
}

/** Intentos fallidos (con error real) tras los que una entidad deja de reintentarse sola. */
export const MAX_INTENTOS = 3;

/**
 * Estado de la exportación: qué entidades faltan, cuáles terminaron y cuáles
 * se rindieron tras MAX_INTENTOS con errores (ésas las revisa una persona).
 */
export async function estadoExportacion(client: SyntageClient): Promise<{
  entidades: Json[];
  pendientes: Json[];
  completas: number;
  atoradas: { rfc: string; errores: string[] }[];
}> {
  const entidades = await client.listEntities();
  const marcas = await prisma.syntageArchivo.findMany({
    where: { tipo: { in: [TIPO_COMPLETO, TIPO_INCOMPLETO] } },
    select: { entityId: true, tipo: true, rfc: true, datos: true },
  });
  const completas = new Set(marcas.filter((m) => m.tipo === TIPO_COMPLETO).map((m) => m.entityId));
  const atoradasMap = new Map<string, { rfc: string; errores: string[] }>();
  for (const m of marcas) {
    const d = m.datos as { intentos?: number; errores?: string[] } | null;
    if (m.tipo === TIPO_INCOMPLETO && (d?.intentos ?? 0) >= MAX_INTENTOS) {
      atoradasMap.set(m.entityId, { rfc: m.rfc, errores: (d?.errores ?? []).slice(0, 5) });
    }
  }
  const pendientes = entidades.filter((e) => {
    const id = idDeEntidad(e);
    return id && !completas.has(id) && !atoradasMap.has(id);
  });
  return { entidades, pendientes, completas: completas.size, atoradas: [...atoradasMap.values()] };
}

/**
 * Borra de Syntage una entidad YA exportada (credenciales + entidad). Exige la
 * fila `export:completo` de esa entidad; sin ella no toca nada.
 */
export async function borrarEntidadExportada(
  client: SyntageClient,
  entidad: Json,
): Promise<{ rfc: string; entityId: string; borrada: boolean; credenciales: number; errores: string[] }> {
  const entityId = idDeEntidad(entidad);
  const rfc = rfcDeEntidad(entidad) || `SIN-RFC-${entityId}`;
  const out = { rfc, entityId, borrada: false, credenciales: 0, errores: [] as string[] };
  const completo = await prisma.syntageArchivo.findFirst({ where: { entityId, tipo: TIPO_COMPLETO }, select: { id: true } });
  if (!completo) {
    out.errores.push("sin export:completo — no se borra");
    return out;
  }
  if (!rfc.startsWith("SIN-RFC")) {
    try {
      for (const c of await client.credencialesDeRfc(rfc)) {
        try {
          await client.deleteCredential(c.id);
          out.credenciales++;
        } catch (e) {
          out.errores.push(`credencial ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      out.errores.push(`credenciales: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    await client.deleteEntity(entityId);
    out.borrada = true;
  } catch (e) {
    out.errores.push(`entidad: ${e instanceof Error ? e.message : String(e)}`);
  }
  await guardar({
    rfc,
    companyId: null,
    entityId,
    tipo: TIPO_BORRADO,
    ref: `/entities/${entityId}`,
    datos: { ...out, fecha: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
  });
  return out;
}
