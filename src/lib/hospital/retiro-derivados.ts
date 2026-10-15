// ─────────────────────────────────────────────────────────────────────────────
// RETIRO DEL CATÁLOGO DERIVADO DE CFDIs (selección pura)
//
// Antes de «la recepción manda», cada renglón de factura de compra daba de
// alta un HospInsumo (derivadoDeCfdi) y escribía kardex. El inventario de
// verdad es el físico (el Excel, derivadoDeCfdi = false). Este módulo decide,
// sin tocar la base, qué hacer con los derivados:
//
//   • REMAPEO — una línea de requisición (SolicitudPartida) que apunta a un
//     derivado se propone pasar al insumo físico con la misma clave o, si no,
//     con el mismo nombre normalizado (del derivado o de la línea). Más de un
//     candidato = ambiguo y NO se toca: lo resuelve una persona.
//   • DESACTIVAR — un derivado sin lotes con existencia, sin movimientos que
//     no sean los del CFDI (ENTRADA_COMPRA/SALIDA_VENTA con factura y sin
//     lote) y sin ninguna otra referencia (protocolos, códigos de barras,
//     conteos, requisiciones de área, renglones de CFDI ligados, claves
//     aprendidas, ni líneas de requisición que se queden sin remapeo).
//
// Nunca se borra nada: --apply sólo remapea y pone activo = false
// (scripts/retirar-insumos-cfdi.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { normalizarDescripcion } from "./cfdi-texto";

export interface InsumoReal {
  id: string;
  clave: string;
  nombre: string;
}

export interface ReferenciasDerivado {
  protocolos: number;
  codigosBarras: number;
  conteoLineas: number;
  lineasArea: number;
  cfdiLineas: number;
  proveedorClaves: number;
}

export interface Derivado {
  id: string;
  clave: string;
  nombre: string;
  lotesConExistencia: number;
  /** Movimientos que NO son los derivados del CFDI (recepción, cargo, ajuste…). */
  movimientosNoCfdi: number;
  referencias: ReferenciasDerivado;
  partidas: Array<{ id: string; descripcion: string; folio?: string | null }>;
}

export type MotivoRemapeo = "clave" | "nombre" | "ambiguo" | "sin-candidato";

export interface Remapeo {
  partidaId: string;
  folio: string | null;
  descripcion: string;
  derivadoId: string;
  derivadoNombre: string;
  propuesto: InsumoReal | null;
  motivo: MotivoRemapeo;
  candidatos: number;
}

export interface Retenido {
  id: string;
  clave: string;
  nombre: string;
  razones: string[];
}

export interface PlanRetiro {
  remapeos: Remapeo[];
  desactivar: InsumoReal[];
  retenidos: Retenido[];
  conteos: {
    derivados: number;
    partidas: number;
    remapeables: number;
    ambiguas: number;
    sinCandidato: number;
    desactivar: number;
    retenidos: number;
  };
}

const norm = (s: string) => normalizarDescripcion(s);

/** El insumo físico que corresponde: clave igual (sin mayúsculas) y, si no hay, nombre normalizado igual. */
export function proponerReal(
  derivado: { clave: string; nombre: string },
  descripcionPartida: string,
  catalogo: InsumoReal[]
): { propuesto: InsumoReal | null; motivo: MotivoRemapeo; candidatos: number } {
  const clave = derivado.clave.trim().toUpperCase();
  const porClave = catalogo.filter((r) => r.clave.trim().toUpperCase() === clave);
  if (porClave.length === 1) return { propuesto: porClave[0], motivo: "clave", candidatos: 1 };
  if (porClave.length > 1) return { propuesto: null, motivo: "ambiguo", candidatos: porClave.length };

  const nombres = new Set([norm(derivado.nombre), norm(descripcionPartida)].filter(Boolean));
  const porNombre = catalogo.filter((r) => nombres.has(norm(r.nombre)));
  const unicos = [...new Map(porNombre.map((r) => [r.id, r])).values()];
  if (unicos.length === 1) return { propuesto: unicos[0], motivo: "nombre", candidatos: 1 };
  if (unicos.length > 1) return { propuesto: null, motivo: "ambiguo", candidatos: unicos.length };
  return { propuesto: null, motivo: "sin-candidato", candidatos: 0 };
}

const ETIQUETA_REF: Record<keyof ReferenciasDerivado, string> = {
  protocolos: "protocolos",
  codigosBarras: "códigos de barras",
  conteoLineas: "conteos físicos",
  lineasArea: "requisiciones de área",
  cfdiLineas: "renglones de CFDI ligados",
  proveedorClaves: "claves de proveedor aprendidas",
};

export function planRetiro(derivados: Derivado[], catalogo: InsumoReal[]): PlanRetiro {
  const remapeos: Remapeo[] = [];
  const desactivar: InsumoReal[] = [];
  const retenidos: Retenido[] = [];

  for (const d of derivados) {
    const razones: string[] = [];
    if (d.lotesConExistencia > 0) razones.push(`${d.lotesConExistencia} lote(s) con existencia`);
    if (d.movimientosNoCfdi > 0) razones.push(`${d.movimientosNoCfdi} movimiento(s) que no son del CFDI`);
    for (const k of Object.keys(ETIQUETA_REF) as Array<keyof ReferenciasDerivado>) {
      if (d.referencias[k] > 0) razones.push(`${d.referencias[k]} ${ETIQUETA_REF[k]}`);
    }

    let sinRemapeo = 0;
    for (const p of d.partidas) {
      const r = proponerReal(d, p.descripcion, catalogo);
      remapeos.push({
        partidaId: p.id,
        folio: p.folio ?? null,
        descripcion: p.descripcion,
        derivadoId: d.id,
        derivadoNombre: d.nombre,
        ...r,
      });
      if (!r.propuesto) sinRemapeo++;
    }
    if (sinRemapeo > 0) razones.push(`${sinRemapeo} línea(s) de requisición sin insumo físico que la reciba`);

    if (razones.length) retenidos.push({ id: d.id, clave: d.clave, nombre: d.nombre, razones });
    else desactivar.push({ id: d.id, clave: d.clave, nombre: d.nombre });
  }

  return {
    remapeos,
    desactivar,
    retenidos,
    conteos: {
      derivados: derivados.length,
      partidas: remapeos.length,
      remapeables: remapeos.filter((r) => r.propuesto).length,
      ambiguas: remapeos.filter((r) => r.motivo === "ambiguo").length,
      sinCandidato: remapeos.filter((r) => r.motivo === "sin-candidato").length,
      desactivar: desactivar.length,
      retenidos: retenidos.length,
    },
  };
}

/** Lo que --apply escribe para poder deshacerlo con --revertir. */
export interface ArchivoReversion {
  version: 1;
  companyId: string;
  rfc: string;
  aplicadoAt: string;
  remapeos: Array<{ partidaId: string; de: string; a: string }>;
  desactivados: string[];
}

export function validarArchivoReversion(x: unknown): ArchivoReversion {
  const a = x as Partial<ArchivoReversion> | null;
  if (!a || a.version !== 1 || typeof a.companyId !== "string" || !Array.isArray(a.remapeos) || !Array.isArray(a.desactivados)) {
    throw new Error("El archivo no es una reversión de retirar-insumos-cfdi (version 1)");
  }
  for (const r of a.remapeos) {
    if (!r || typeof r.partidaId !== "string" || typeof r.de !== "string" || typeof r.a !== "string") throw new Error("Remapeo inválido en el archivo");
  }
  if (a.desactivados.some((id) => typeof id !== "string")) throw new Error("Id inválido en desactivados");
  return a as ArchivoReversion;
}
