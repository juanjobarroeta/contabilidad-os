// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — validación de los códigos que propone el modelo.
//
// Cada código propuesto pasa por `resolverCie` (existe, es codificable —
// activo —, coherente con sexo y edad del paciente); el que no pasa se
// descarta con una advertencia que dice por qué. Se deduplica por clave DGIS y
// se ordena: principal primero, luego por confianza. Recibe el cliente Prisma
// (o la transacción) como cie.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCatalogoTipo, Prisma, PrismaClient } from "@prisma/client";
import { claveDeCodigoCie, normalizarCodigoCie, resolverCie, type PacienteParaCie } from "../cie";
import { HospitalError } from "../errores";

type Db = PrismaClient | Prisma.TransactionClient;

export interface CodigoPropuesto {
  codigo: string;
  /** Nombre que dio el modelo (se sustituye por el del catálogo al validar). */
  nombre: string | null;
  confianza: number;
  fragmento: string | null;
  principal: boolean;
}

export interface CodigoValidado {
  /** Forma clínica del catálogo: «K80.2», «51.23». */
  codigo: string;
  /** Clave DGIS sin punto: «K802», «5123». */
  clave: string;
  nombre: string;
  capitulo: string | null;
  confianza: number;
  fragmento: string | null;
  principal: boolean;
}

const MAX_CODIGOS = 20;
const MAX_FRAGMENTO = 300;

function numero01(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Lo que el modelo contestó en un arreglo de códigos, ya saneado; lo malformado se ignora. */
export function leerPropuestas(raw: unknown): CodigoPropuesto[] {
  if (!Array.isArray(raw)) return [];
  const out: CodigoPropuesto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const codigo = typeof o.codigo === "string" ? normalizarCodigoCie(o.codigo) : "";
    if (!codigo) continue;
    out.push({
      codigo,
      nombre: typeof o.nombre === "string" && o.nombre.trim() ? o.nombre.trim() : null,
      confianza: numero01(o.confianza),
      fragmento: typeof o.fragmento === "string" && o.fragmento.trim() ? o.fragmento.trim().slice(0, MAX_FRAGMENTO) : null,
      principal: o.principal === true,
    });
    if (out.length >= MAX_CODIGOS) break;
  }
  return out;
}

/** Un solo código propuesto (la causa externa), o null. */
export function leerPropuesta(raw: unknown): CodigoPropuesto | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return leerPropuestas([raw])[0] ?? null;
}

export interface ValidarCodigosOpciones {
  tipo: HospCatalogoTipo;
  paciente?: PacienteParaCie | null;
  /** «El diagnóstico propuesto» / «El procedimiento propuesto»: encabeza los motivos. */
  etiqueta: string;
  hoy?: Date;
  /** Sólo capítulo XX (causa externa). */
  soloCapituloXX?: boolean;
}

/**
 * Valida cada propuesta contra el catálogo y el paciente. Nunca lanza: los
 * códigos que no pasan salen en `advertencias` con el motivo del catálogo.
 */
export async function validarCodigos(
  db: Db,
  propuestas: CodigoPropuesto[],
  opciones: ValidarCodigosOpciones
): Promise<{ validos: CodigoValidado[]; advertencias: string[] }> {
  const validos: CodigoValidado[] = [];
  const advertencias: string[] = [];
  const vistas = new Set<string>();
  for (const p of propuestas) {
    const clave = claveDeCodigoCie(p.codigo);
    if (vistas.has(clave)) continue;
    try {
      const fila = await resolverCie(db, opciones.tipo, p.codigo, { etiqueta: opciones.etiqueta, paciente: opciones.paciente, hoy: opciones.hoy });
      if (opciones.soloCapituloXX && fila.capitulo !== "XX") {
        advertencias.push(`Se descartó «${fila.codigo} ${fila.nombre}» como causa externa: no es del capítulo XX (V01-Y98)`);
        continue;
      }
      vistas.add(fila.clave);
      validos.push({ codigo: fila.codigo, clave: fila.clave, nombre: fila.nombre, capitulo: fila.capitulo, confianza: p.confianza, fragmento: p.fragmento, principal: p.principal });
    } catch (e) {
      if (e instanceof HospitalError) {
        advertencias.push(`Se descartó el código propuesto «${p.codigo}»${p.nombre ? ` (${p.nombre})` : ""}: ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  validos.sort((a, b) => Number(b.principal) - Number(a.principal) || b.confianza - a.confianza);
  return { validos, advertencias };
}
