// ─────────────────────────────────────────────────────────────────────────────
// Diagnósticos y procedimientos POR CATÁLOGO (NOM-024-SSA3-2012, SAEH).
//
// HospCatalogo guarda la CIE-10 (diagnósticos) y la CIE-9-MC (procedimientos)
// tal como las publica la DGIS: `clave` sin punto («K802», «5123») y
// `codigo` en su forma clínica («K80.2», «51.23»). El piso captura cualquiera
// de las dos; aquí se resuelve a la fila, se rechaza lo que la DGIS marca
// como no codificable (categorías con subcategorías, claves erradicadas) y
// se cruza con el sexo y la edad del paciente cuando el catálogo los acota.
// Sin Prisma «real»: recibe el cliente o la transacción para que corra
// dentro de crearEpisodio y desde los scripts.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCatalogoTipo, HospSexo, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";

type Db = PrismaClient | Prisma.TransactionClient;

export const NOMBRE_CATALOGO: Record<HospCatalogoTipo, string> = { CIE10: "CIE-10", CIE9MC: "CIE-9-MC" };

/** Código como lo capturó el piso → forma normalizada («k80.2 » → «K80.2»). */
export function normalizarCodigoCie(entrada: string): string {
  return entrada.trim().toUpperCase().replace(/\s+/g, "");
}

/** Clave DGIS (sin punto) de un código clínico: «K80.2» → «K802», «51.23» → «5123». */
export function claveDeCodigoCie(codigo: string): string {
  return normalizarCodigoCie(codigo).replace(/\./g, "");
}

export interface FilaCie {
  tipo: HospCatalogoTipo;
  clave: string;
  codigo: string;
  nombre: string;
  nivel: number;
  capitulo: string | null;
  capituloNombre: string | null;
  subtipo: string | null;
  sexo: string | null;
  edadMin: number | null;
  edadMax: number | null;
  activo: boolean;
}

const selectCie = {
  tipo: true, clave: true, codigo: true, nombre: true, nivel: true, capitulo: true, capituloNombre: true,
  subtipo: true, sexo: true, edadMin: true, edadMax: true, activo: true,
} as const;

/**
 * Busca la fila por código o clave (con o sin punto). Las categorías de tres
 * caracteres sin subcategoría viven en la DGIS como «I10.X»: se prueba
 * también esa forma. Devuelve null si no existe; no filtra `activo`.
 */
export async function buscarCie(db: Db, tipo: HospCatalogoTipo, entrada: string): Promise<FilaCie | null> {
  const codigo = normalizarCodigoCie(entrada);
  if (!codigo) return null;
  const clave = claveDeCodigoCie(codigo);
  const fila = await db.hospCatalogo.findFirst({
    where: { tipo, OR: [{ codigo }, { clave }, { codigo: `${codigo}.X` }, { clave: `${clave}X` }] },
    orderBy: [{ activo: "desc" }, { nivel: "asc" }],
    select: selectCie,
  });
  return fila;
}

export interface PacienteParaCie {
  sexo?: HospSexo | null;
  fechaNacimiento?: Date | null;
}

function edadEnDias(fechaNacimiento: Date, hoy: Date): number {
  return Math.max(0, Math.floor((hoy.getTime() - fechaNacimiento.getTime()) / 86_400_000));
}

function edadTexto(dias: number): string {
  const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  if (dias >= 365) return plural(Math.floor(dias / 365.25), "año", "años");
  if (dias >= 60) return plural(Math.floor(dias / 30.4), "mes", "meses");
  return plural(dias, "día", "días");
}

/**
 * Resuelve un código y lo valida contra el catálogo y el paciente. Lanza
 * HospitalError(400) con el motivo en español; devuelve la fila con el código
 * en su forma clínica, que es la que se guarda en el episodio.
 */
export async function resolverCie(
  db: Db,
  tipo: HospCatalogoTipo,
  entrada: string,
  opciones: { etiqueta: string; paciente?: PacienteParaCie | null; hoy?: Date } = { etiqueta: "El código" }
): Promise<FilaCie> {
  const nombreCatalogo = NOMBRE_CATALOGO[tipo];
  const fila = await buscarCie(db, tipo, entrada);
  if (!fila) throw new HospitalError(400, `${opciones.etiqueta} «${normalizarCodigoCie(entrada)}» no existe en el catálogo ${nombreCatalogo}`);
  if (!fila.activo) {
    const pista = tipo === "CIE10" ? "usa una subcategoría (con decimal)" : "usa un procedimiento específico del catálogo";
    throw new HospitalError(400, `${opciones.etiqueta} «${fila.codigo} ${fila.nombre}» no es válido para codificar en ${nombreCatalogo}: ${pista}`);
  }
  const p = opciones.paciente;
  if (p?.sexo && fila.sexo && (p.sexo === "FEMENINO" || p.sexo === "MASCULINO")) {
    const esperado = fila.sexo.toUpperCase().startsWith("F") ? "FEMENINO" : fila.sexo.toUpperCase().startsWith("M") ? "MASCULINO" : null;
    if (esperado && esperado !== p.sexo) {
      throw new HospitalError(400, `${opciones.etiqueta} «${fila.codigo} ${fila.nombre}» es exclusivo de sexo ${esperado === "FEMENINO" ? "femenino" : "masculino"} y el paciente es ${p.sexo.toLowerCase()}`);
    }
  }
  if (p?.fechaNacimiento && (fila.edadMin != null || fila.edadMax != null)) {
    const dias = edadEnDias(p.fechaNacimiento, opciones.hoy ?? new Date());
    if ((fila.edadMin != null && dias < fila.edadMin) || (fila.edadMax != null && dias > fila.edadMax)) {
      const rango = `${fila.edadMin != null ? edadTexto(fila.edadMin) : "0"} a ${fila.edadMax != null ? edadTexto(fila.edadMax) : "sin límite"}`;
      throw new HospitalError(400, `${opciones.etiqueta} «${fila.codigo} ${fila.nombre}» no aplica a la edad del paciente (${edadTexto(dias)}; el catálogo lo acota a ${rango})`);
    }
  }
  return fila;
}

export interface NombresCie {
  ingreso: { codigo: string; nombre: string } | null;
  egreso: { codigo: string; nombre: string } | null;
  procedimiento: { codigo: string; nombre: string } | null;
}

/** Los nombres de catálogo de los códigos del episodio, para enseñarlos sin otra llamada. */
export async function nombresCie(
  db: Db,
  ep: { diagnosticoIngresoCie10: string | null; diagnosticoEgresoCie10: string | null; procedimientoCie9: string | null }
): Promise<NombresCie> {
  const uno = async (tipo: HospCatalogoTipo, codigo: string | null) => {
    if (!codigo) return null;
    const fila = await buscarCie(db, tipo, codigo);
    return fila ? { codigo: fila.codigo, nombre: fila.nombre } : { codigo, nombre: "(no está en el catálogo)" };
  };
  const [ingreso, egreso, procedimiento] = await Promise.all([
    uno("CIE10", ep.diagnosticoIngresoCie10),
    uno("CIE10", ep.diagnosticoEgresoCie10),
    uno("CIE9MC", ep.procedimientoCie9),
  ]);
  return { ingreso, egreso, procedimiento };
}
