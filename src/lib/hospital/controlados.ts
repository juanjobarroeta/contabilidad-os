import type { HospGrupoControl } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Medicamentos controlados — fracciones de la Ley General de Salud.
//
// Art. 234 (estupefacientes) y art. 245 (psicotrópicos, fracciones I-V). Lo
// que cambia en la operación: los grupos I y II exigen receta especial con
// código de barras y libro de control autorizado por COFEPRIS; el grupo III
// receta ordinaria retenida (hasta tres surtidos) y también libro; IV-VI sólo
// receta. Esta lista es una PROPUESTA por sustancia activa para etiquetar los
// insumos que se derivan de los CFDIs; el responsable sanitario confirma o
// corrige el grupo en Farmacia. Ante la duda, la sustancia NO se etiqueta.
// ─────────────────────────────────────────────────────────────────────────────

const GRUPOS: Array<[HospGrupoControl, string[]]> = [
  // Estupefacientes (art. 234) y psicotrópicos con el mayor control.
  ["I", ["MORFINA", "FENTANILO", "FENTANIL", "OXICODONA", "HIDROMORFONA", "METADONA", "MEPERIDINA", "PETIDINA", "SUFENTANILO", "REMIFENTANILO", "ALFENTANILO", "TAPENTADOL", "CODEINA"]],
  // Psicotrópicos de alto potencial de abuso (art. 245-II).
  ["II", ["METILFENIDATO", "PENTOBARBITAL", "SECOBARBITAL", "ANFETAMINA", "DEXTROANFETAMINA", "LISDEXANFETAMINA"]],
  // Benzodiacepinas y afines (art. 245-III).
  ["III", ["MIDAZOLAM", "DIAZEPAM", "LORAZEPAM", "ALPRAZOLAM", "CLONAZEPAM", "BROMAZEPAM", "TRIAZOLAM", "FLUNITRAZEPAM", "ZOLPIDEM", "FENOBARBITAL", "CLOBAZAM"]],
];

/** Variantes ortográficas → nombre con el que se guarda la sustancia activa. */
const CANONICA: Record<string, string> = { FENTANIL: "FENTANILO", PETIDINA: "MEPERIDINA" };

/** Grupos que exigen libro de control autorizado por COFEPRIS. */
export const GRUPOS_LIBRO_CONTROL: readonly HospGrupoControl[] = ["I", "II", "III"];

export interface SustanciaControlada {
  grupo: HospGrupoControl;
  /** Sustancia activa como se guarda en el insumo: «Midazolam», «Fentanilo». */
  sustancia: string;
}

const capitalizar = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/**
 * Sustancia controlada que delata la descripción del insumo y su grupo
 * propuesto, o null cuando no está en la lista.
 */
export function sustanciaControladaPorNombre(nombre: string | null | undefined): SustanciaControlada | null {
  const n = (nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  if (!n) return null;
  for (const [grupo, sustancias] of GRUPOS) {
    for (const s of sustancias) {
      // Palabra completa o prefijo con sal («MIDAZOLAM CLORHIDRATO», «FENTANILO CITRATO»).
      if (new RegExp(`(^|[^A-Z])${s}([^A-Z]|$)`).test(n)) {
        return { grupo, sustancia: capitalizar(CANONICA[s] ?? s) };
      }
    }
  }
  return null;
}

/** Grupo de control propuesto para una descripción de insumo, o null. */
export function grupoControlPorNombre(nombre: string | null | undefined): HospGrupoControl | null {
  return sustanciaControladaPorNombre(nombre)?.grupo ?? null;
}

/** Grupos que exigen libro de control autorizado por COFEPRIS. */
export function exigeLibroControl(grupo: HospGrupoControl | null | undefined): boolean {
  return grupo === "I" || grupo === "II" || grupo === "III";
}

/** Grupos que exigen receta especial con código de barras. */
export function exigeRecetaEspecial(grupo: HospGrupoControl | null | undefined): boolean {
  return grupo === "I" || grupo === "II";
}

/** Banderas con las que el satélite etiqueta un insumo por su grupo. */
export function banderasControl(grupo: HospGrupoControl | null | undefined): {
  exigeLibroControl: boolean;
  exigeRecetaEspecial: boolean;
} {
  return { exigeLibroControl: exigeLibroControl(grupo), exigeRecetaEspecial: exigeRecetaEspecial(grupo) };
}

/** Cómo se llama la receta que ampara una salida del grupo (para mensajes). */
export function nombreReceta(grupo: HospGrupoControl | null | undefined): string {
  if (exigeRecetaEspecial(grupo)) return "receta especial con código de barras";
  if (grupo === "III") return "receta ordinaria retenida";
  return "receta";
}
