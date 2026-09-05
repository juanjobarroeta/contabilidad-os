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

/** Grupo de control propuesto para una descripción de insumo, o null. */
export function grupoControlPorNombre(nombre: string | null | undefined): HospGrupoControl | null {
  const n = (nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  if (!n) return null;
  for (const [grupo, sustancias] of GRUPOS) {
    for (const s of sustancias) {
      // Palabra completa o prefijo con sal («MIDAZOLAM CLORHIDRATO», «FENTANILO CITRATO»).
      if (new RegExp(`(^|[^A-Z])${s}([^A-Z]|$)`).test(n)) return grupo;
    }
  }
  return null;
}

/** Grupos que exigen libro de control autorizado por COFEPRIS. */
export function exigeLibroControl(grupo: HospGrupoControl | null | undefined): boolean {
  return grupo === "I" || grupo === "II" || grupo === "III";
}

/** Grupos que exigen receta especial con código de barras. */
export function exigeRecetaEspecial(grupo: HospGrupoControl | null | undefined): boolean {
  return grupo === "I" || grupo === "II";
}
