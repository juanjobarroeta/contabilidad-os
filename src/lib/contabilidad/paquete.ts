// ─────────────────────────────────────────────────────────────────────────────
// Paquete mensual — qué lleva la entrega y cómo se nombra cada archivo.
//
// PURO: decide nombres y arma el manifiesto. El zip y las consultas viven en la
// ruta; aquí está lo que hay que poder probar sin base de datos.
//
// Dos sabores, porque el SAT pide cosas distintas en momentos distintos:
//   • ENTREGA MENSUAL — catálogo y balanza (Art. 33 RCFF, ap. B, frac. III y
//     IV) más los estados financieros y la DIOT. Es lo que se manda cada mes.
//   • REQUERIMIENTO — además, pólizas y sus dos auxiliares (frac. V). Sólo
//     aplica cuando hay auditoría, devolución o compensación, y por eso exige
//     el folio del acto: sin él, el XML sale sin el atributo obligatorio.
//
// El manifiesto no es decoración: quien recibe el zip necesita saber qué mes
// es, si el periodo estaba posteado y qué NO se incluyó. Un paquete al que le
// falta algo en silencio es peor que uno que lo declara.
// ─────────────────────────────────────────────────────────────────────────────

import { clavePeriodo, etiquetaPeriodo } from "./reportes-xlsx";

/** Tipos de solicitud del Anexo 24 que piden pólizas y auxiliares. */
export type TipoSolicitudPaquete = "AF" | "FC" | "DE" | "CO";

/** AF (acto de fiscalización) y FC (fiscalización compulsa) usan NumOrden;
 *  DE (devolución) y CO (compensación) usan NumTramite. */
export function campoFolio(tipo: TipoSolicitudPaquete): "numOrden" | "numTramite" {
  return tipo === "AF" || tipo === "FC" ? "numOrden" : "numTramite";
}

/**
 * Nombre de archivo del SAT: RFC + AAAA + MM + clave + tipo de envío + .XML.
 * Cada entregable tiene su clave (B balanza, CT catálogo, PL pólizas…).
 */
export function nombreArchivoSat(
  rfc: string,
  year: number,
  month: number,
  clave: string,
  sufijo = ""
): string {
  return `${rfc}${year}${String(month).padStart(2, "0")}${clave}${sufijo}.XML`;
}

export interface ArchivoPaquete {
  /** Ruta dentro del zip. */
  ruta: string;
  /** Qué es, para el manifiesto. */
  descripcion: string;
}

export interface ResumenPaquete {
  rfc: string;
  razonSocial: string;
  year: number;
  month: number;
  /** ¿El periodo contable estaba POSTED/CLOSED al armar el paquete? */
  posteado: boolean;
  /** Estado del semáforo de contabilidad electrónica. */
  readiness: "lista" | "con_huecos" | "incompleta";
  archivos: ArchivoPaquete[];
  /** Lo que NO se incluyó y por qué. Se declara, no se calla. */
  omitidos: string[];
  generadoEn: string;
}

/** Carpeta del zip por tipo de contenido. */
export const CARPETA = {
  xml: "01-XML SAT",
  estados: "02-Estados financieros",
  declaraciones: "03-Declaraciones",
} as const;

/**
 * Manifiesto en texto plano. Va en la raíz del zip para que quien lo abra
 * entienda el contenido sin preguntar.
 */
export function renderManifiesto(r: ResumenPaquete): string {
  const l: string[] = [];
  l.push(`PAQUETE CONTABLE — ${etiquetaPeriodo(r.year, r.month).toUpperCase()}`);
  l.push("=".repeat(60));
  l.push("");
  l.push(`Empresa:    ${r.razonSocial}`);
  l.push(`RFC:        ${r.rfc}`);
  l.push(`Periodo:    ${clavePeriodo(r.year, r.month)}`);
  l.push(`Generado:   ${r.generadoEn}`);
  l.push("");

  // El estado del periodo cambia lo que significan las cifras: sin postear son
  // preliminares y no deben mandarse al SAT como definitivas.
  l.push(
    r.posteado
      ? "Periodo POSTEADO: las cifras salen del ledger."
      : "Periodo SIN POSTEAR: las cifras son PRELIMINARES, derivadas de los CFDIs."
  );
  const semaforo = {
    lista: "Contabilidad electrónica LISTA para enviar.",
    con_huecos: "Contabilidad electrónica CON HUECOS: revisa los pendientes antes de enviar.",
    incompleta: "Contabilidad electrónica INCOMPLETA: no la envíes todavía.",
  };
  l.push(semaforo[r.readiness]);
  l.push("");

  l.push("CONTENIDO");
  l.push("-".repeat(60));
  for (const a of r.archivos) l.push(`  ${a.ruta}\n      ${a.descripcion}`);
  l.push("");

  if (r.omitidos.length > 0) {
    l.push("NO INCLUIDO");
    l.push("-".repeat(60));
    for (const o of r.omitidos) l.push(`  - ${o}`);
    l.push("");
  }

  l.push(
    "Los XML del Anexo 24 se cargan en el portal del SAT (Contabilidad Electrónica).",
    "Este paquete no se envía solo."
  );
  return l.join("\n");
}

/** Nombre del zip. Lleva RFC y periodo porque termina en la carpeta del cliente. */
export function nombreZip(rfc: string, year: number, month: number): string {
  return `Paquete contable ${rfc} ${clavePeriodo(year, month)}.zip`;
}
