// ─────────────────────────────────────────────────────────────────────────────
// El texto de un CFDI leído como dato del módulo: normalizar la descripción de
// un concepto, sacar de ella el nombre del paciente («px …», «paciente …»),
// partirlo en nombre y apellidos, y decidir a qué categoría de cargo
// pertenece el renglón.
//
// Vive aparte porque lo comparten el bootstrap (tarifario y pacientes) y la
// derivación de expedientes históricos (episodios-cfdi.ts): la regla que
// convierte «Servicios hospitalarios PX Jessica Barranco Lima» en un paciente
// tiene que ser LA MISMA en el script y en la lib. Sin base de datos.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCargoCategoria } from "@prisma/client";

/** MAYÚSCULAS, sin acentos, sólo alfanuméricos separados por un espacio. */
export function normalizarDescripcion(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Partículas que van en minúscula dentro de un nombre y se pegan al apellido. */
const MINUSCULAS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y", "E", "DA", "DI", "VON", "VAN"]);
const SIGLAS = new Set(["SA", "CV", "SAPI", "SC", "AC", "SRL", "RL", "SAS", "SCP", "IAP", "SNC", "SPR", "SOFOM", "ENR", "ER", "II", "III", "IV"]);

/** «JUAN DE LA TORRE SA DE CV» → «Juan de la Torre SA de CV». */
export function nombrePropio(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const u = w.toUpperCase();
      if (i > 0 && MINUSCULAS.has(u)) return u.toLowerCase();
      if (SIGLAS.has(u.replace(/\./g, ""))) return u;
      return u.charAt(0) + u.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Categoría del cargo/servicio que le toca a la descripción de un concepto. */
export function categoriaDe(desc: string): HospCargoCategoria {
  const d = normalizarDescripcion(desc);
  if (/HONORARIO/.test(d)) return "HONORARIO";
  if (/FARMACIA|MEDICAMENTO/.test(d)) return "FARMACIA";
  if (/CENTRAL DE EQUIPOS|ESTERILIZACION|MATERIAL|INSUMO/.test(d)) return "MATERIAL";
  if (/QUIROFANO|SALA DE OPERACION/.test(d)) return "QUIROFANO";
  if (/URGENCIA/.test(d)) return "URGENCIAS";
  if (/HOSPITALIZACION|HABITACION|RECUPERACION|ESTANCIA|TERAPIA INTENSIVA|CUIDADOS INTENSIVOS|CUNERO/.test(d)) return "HABITACION";
  if (/LABORATORIO|PATOLOGIA|TOMOGRAFIA|RAYOS X|ULTRASONIDO|RESONANCIA|ESTUDIO|IMAGEN|ELECTROCARDIOGRAMA|MASTOGRAFIA|DENSITOMETRIA/.test(d)) return "ESTUDIO";
  if (/ENDOSCOPIA|COLONOSCOPIA|PAQUETE|CIRUGIA|PROCEDIMIENTO|BIOPSIA|QUIMIOTERAPIA|ONCOLOG|INFUSION|SESION|INHALOTERAPIA|TERAPIA|BANCO DE SANGRE|TRANSFUSION/.test(d)) return "PROCEDIMIENTO";
  if (/EQUIPO|RENTA/.test(d)) return "EQUIPO";
  return "OTRO";
}

// «Servicio de hospitalización PX Viridiana Marquez Palacios» → «VIRIDIANA MARQUEZ PALACIOS»
const PACIENTE_RE = /(?:\bPACIENTE|\bPX)\b\.?\s*[:\-]?\s*([A-ZÑ][A-ZÑ]+(?:\s+(?:DE|DEL|LA|LAS|LOS|Y|[A-ZÑ][A-ZÑ]+)){1,6})/;

/** El nombre del paciente que nombra el concepto, en MAYÚSCULAS sin acentos; null si no lo nombra. */
export function nombreDePaciente(desc: string): string | null {
  const m = (desc ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .match(PACIENTE_RE);
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter((t) => !/^(SERVICIO|SERVICIOS|HOSPITALIZACION|CON|POR|EL|EN|UN|UNA)$/.test(t));
  while (tokens.length && MINUSCULAS.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length < 2 || tokens.length > 7) return null;
  return tokens.join(" ");
}

/**
 * «MARIA GUADALUPE DE LA TORRE VARGAS» → nombre «Maria Guadalupe», paterno
 * «De la Torre», materno «Vargas». Los apellidos van al final y las
 * partículas se pegan al apellido que encabezan.
 */
export function partirNombre(completo: string): { nombre: string; apellidoPaterno: string; apellidoMaterno: string | null } {
  const t = completo.trim().split(/\s+/).filter(Boolean);
  const apellidos: string[] = [];
  while (t.length > 1 && apellidos.length < 2) {
    let ap = t.pop()!;
    while (t.length > 1 && MINUSCULAS.has(t[t.length - 1])) ap = `${t.pop()} ${ap}`;
    apellidos.unshift(ap);
  }
  return {
    nombre: nombrePropio(t.join(" ")),
    apellidoPaterno: nombrePropio(apellidos[0] ?? ""),
    apellidoMaterno: apellidos[1] ? nombrePropio(apellidos[1]) : null,
  };
}
