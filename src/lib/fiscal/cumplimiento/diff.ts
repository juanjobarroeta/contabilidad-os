// ─────────────────────────────────────────────────────────────────────────────
// Detección de cambios de cumplimiento → Hallazgos. Esta es la lógica de valor:
// convertir una opinión/CSF recién obtenida (y la anterior) en la alerta
// correcta. Reutiliza el tipo Hallazgo del auditor para persistir igual.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hallazgo } from "../audit/types";
import type {
  ComplianceResult,
  CsfResult,
  OpinionResult,
} from "./types";

const ETIQUETA: Record<string, string> = {
  SAT_OPINION: "opinión de cumplimiento SAT (32-D)",
  IMSS_OPINION: "opinión de cumplimiento IMSS",
  CSF: "constancia de situación fiscal",
};

/** Hash estable del contenido relevante, para detectar cambios entre corridas. */
export function hashContenido(r: ComplianceResult): string {
  const salient =
    r.tipo === "CSF"
      ? {
          t: r.tipo,
          estatus: r.perfil.estatusPadron,
          reg: [...r.perfil.regimenes].sort(),
          obl: [...r.perfil.obligaciones].sort(),
          cp: r.perfil.codigoPostal ?? "",
        }
      : { t: r.tipo, res: r.resultado, mot: [...r.motivos].sort() };
  // Hash determinista simple (FNV-1a) — no cripto, solo cambio-detección.
  const s = JSON.stringify(salient);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function evaluarOpinion(next: OpinionResult, prev: OpinionResult | null): Hallazgo[] {
  const etiqueta = ETIQUETA[next.tipo];
  const out: Hallazgo[] = [];
  const fundamento = { ley: "CFF", articulo: "32-D" };

  if (next.resultado === "NEGATIVA") {
    const transicion =
      prev && prev.resultado === "POSITIVA" ? " (cambió de POSITIVA a NEGATIVA)" : "";
    out.push({
      checkClave: `cumplimiento.${next.tipo.toLowerCase()}.negativa`,
      severidad: "error",
      mensaje: `La ${etiqueta} es NEGATIVA${transicion}${
        next.motivos.length ? `: ${next.motivos.join("; ")}` : "."
      }`,
      referencias: [],
      fundamento,
      sugerencia:
        "Regulariza las obligaciones omitidas de inmediato — una opinión negativa bloquea contratos, licitaciones, créditos y estímulos.",
    });
  } else if (next.resultado === "POSITIVA" && prev && prev.resultado === "NEGATIVA") {
    out.push({
      checkClave: `cumplimiento.${next.tipo.toLowerCase()}.regularizada`,
      severidad: "info",
      mensaje: `La ${etiqueta} volvió a POSITIVA.`,
      referencias: [],
      fundamento,
      sugerencia: "Sin acción; el cumplimiento se regularizó.",
    });
  } else if (next.resultado === "NO_LOCALIZADO" || next.resultado === "ERROR") {
    out.push({
      checkClave: `cumplimiento.${next.tipo.toLowerCase()}.no_disponible`,
      severidad: "warn",
      mensaje: `No se pudo obtener la ${etiqueta} (${next.resultado}).`,
      referencias: [],
      fundamento,
      sugerencia: "Verifica credenciales (e.firma/CIEC) y estatus del RFC.",
    });
  }
  return out;
}

function evaluarCsf(next: CsfResult, prev: CsfResult | null): Hallazgo[] {
  const out: Hallazgo[] = [];
  const fundamento = { ley: "CFF", articulo: "27" };

  if (next.perfil.estatusPadron === "SUSPENDIDO" || next.perfil.estatusPadron === "CANCELADO") {
    out.push({
      checkClave: "cumplimiento.csf.estatus",
      severidad: "error",
      mensaje: `El RFC está ${next.perfil.estatusPadron} en el padrón del SAT.`,
      referencias: [],
      fundamento,
      sugerencia: "Reactiva el RFC ante el SAT; suspendido/cancelado impide facturar y operar.",
    });
  }

  if (!prev) return out; // primera captura: sin diff de perfil

  const nuevasObl = next.perfil.obligaciones.filter((o) => !prev.perfil.obligaciones.includes(o));
  const quitadas = prev.perfil.obligaciones.filter((o) => !next.perfil.obligaciones.includes(o));
  if (nuevasObl.length || quitadas.length) {
    out.push({
      checkClave: "cumplimiento.csf.obligaciones",
      severidad: "warn",
      mensaje: `Cambiaron tus obligaciones fiscales${
        nuevasObl.length ? ` (+${nuevasObl.join(", ")})` : ""
      }${quitadas.length ? ` (-${quitadas.join(", ")})` : ""}.`,
      referencias: [],
      fundamento,
      sugerencia: "Revisa el calendario de obligaciones y la configuración fiscal de la empresa.",
    });
  }

  const regNuevos = next.perfil.regimenes.filter((r) => !prev.perfil.regimenes.includes(r));
  const regQuitados = prev.perfil.regimenes.filter((r) => !next.perfil.regimenes.includes(r));
  if (regNuevos.length || regQuitados.length) {
    out.push({
      checkClave: "cumplimiento.csf.regimen",
      severidad: "warn",
      mensaje: `Cambió tu régimen fiscal${regNuevos.length ? ` (+${regNuevos.join(", ")})` : ""}${
        regQuitados.length ? ` (-${regQuitados.join(", ")})` : ""
      }.`,
      referencias: [],
      fundamento,
      sugerencia: "Actualiza el régimen en la empresa; cambia las reglas fiscales aplicables.",
    });
  }

  if (next.perfil.codigoPostal && prev.perfil.codigoPostal &&
      next.perfil.codigoPostal !== prev.perfil.codigoPostal) {
    out.push({
      checkClave: "cumplimiento.csf.domicilio",
      severidad: "warn",
      mensaje: `Cambió tu domicilio fiscal (CP ${prev.perfil.codigoPostal} → ${next.perfil.codigoPostal}).`,
      referencias: [],
      fundamento,
      sugerencia: "Puede cambiar tu entidad para impuestos estatales (p.ej. ISN).",
    });
  }
  return out;
}

/**
 * Compara el resultado nuevo contra el anterior y produce los Hallazgos. `prev`
 * null = primera captura (solo alerta estados absolutos como negativa/suspendido).
 */
export function evaluarCambioCumplimiento(
  next: ComplianceResult,
  prev: ComplianceResult | null,
): Hallazgo[] {
  if (next.tipo === "CSF") {
    return evaluarCsf(next, prev && prev.tipo === "CSF" ? prev : null);
  }
  return evaluarOpinion(next, prev && prev.tipo === next.tipo ? prev : null);
}
