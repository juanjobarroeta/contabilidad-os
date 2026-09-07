// ─────────────────────────────────────────────────────────────────────────────
// ¿Está presentada, y CÓMO lo sabemos? Puro.
//
// Juan, probando el cierre: «si tenemos las declaraciones del SAT, ¿por qué hay
// un botón "marcar como presentada"? Deberíamos saber qué está presentado
// porque tenemos la evidencia». Tiene razón: el backfill de Syntage crea la
// fila FILED con su acuse PDF, su línea de captura y su fecha —y la pantalla
// seguía ofreciendo marcarla a mano, como si no supiéramos nada.
//
// La regla es la misma de todo el sistema: un dato con procedencia y un dato
// capturado NO son lo mismo. Aquí se decide una sola vez para que ninguna
// pantalla vuelva a preguntar lo que ya tiene probado.
// ─────────────────────────────────────────────────────────────────────────────

/** Los rastros que deja una presentación en TaxDeclaration (sin los bytes). */
export interface RastroPresentacion {
  status?: string | null;
  isHistorical?: boolean | null;
  acusePdfNombre?: string | null;
  acuseUrl?: string | null;
  lineaCaptura?: string | null;
  acuseData?: unknown;
  fechaPresentacion?: Date | string | null;
}

/**
 * Dónde nace la certeza de que se presentó:
 * · `acuse`   — tenemos el documento (PDF guardado o URL del acuse).
 * · `sat`     — el registro viene del SAT (línea de captura / importes leídos
 *               del acuse / fecha de presentación) aunque el PDF no se guardara.
 * · `manual`  — alguien la marcó en la app y no hay ningún rastro del SAT.
 * · `ninguno` — no está presentada.
 */
export type OrigenPresentacion = "acuse" | "sat" | "manual" | "ninguno";

export interface EvidenciaPresentacion {
  presentada: boolean;
  /** Hay algo del SAT que lo respalda (no la palabra de alguien). */
  conEvidencia: boolean;
  origen: OrigenPresentacion;
  /** Dicho en llano, para pegarlo tal cual junto a la cifra. */
  etiqueta: string;
  fecha: Date | null;
  /** El acuse se puede descargar de la app. */
  acuseDescargable: boolean;
}

const PRESENTADA_STATUSES = new Set(["FILED", "PAID"]);

function aFecha(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ¿La fila trae rastro de acuse? Misma definición que usaba `apertura.ts` (de
 * donde salió), para que la procedencia del punto de partida y lo que muestran
 * las pantallas no puedan discrepar.
 */
export function tieneAcuse(row: RastroPresentacion): boolean {
  return (
    row.acusePdfNombre != null ||
    row.acuseUrl != null ||
    row.lineaCaptura != null ||
    row.acuseData != null ||
    row.fechaPresentacion != null
  );
}

function fmtFecha(d: Date | null): string {
  if (!d) return "";
  return ` del ${d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
}

/** La única lectura de «presentada» del sistema. */
export function evidenciaPresentacion(row: RastroPresentacion | null | undefined): EvidenciaPresentacion {
  if (!row) {
    return {
      presentada: false,
      conEvidencia: false,
      origen: "ninguno",
      etiqueta: "sin presentar",
      fecha: null,
      acuseDescargable: false,
    };
  }
  const fecha = aFecha(row.fechaPresentacion);
  const acuseDescargable = row.acusePdfNombre != null || row.acuseUrl != null;
  const delSat = row.lineaCaptura != null || row.acuseData != null || fecha != null;
  const presentada = PRESENTADA_STATUSES.has(String(row.status ?? ""));

  if (acuseDescargable) {
    return {
      presentada: true, // el acuse ES la presentación, dé lo que dé el status
      conEvidencia: true,
      origen: "acuse",
      etiqueta: `presentada — acuse del SAT${fmtFecha(fecha)}`,
      fecha,
      acuseDescargable: true,
    };
  }
  if (delSat) {
    return {
      presentada: true,
      conEvidencia: true,
      origen: "sat",
      etiqueta: `presentada — registro del SAT${fmtFecha(fecha)}`,
      fecha,
      acuseDescargable: false,
    };
  }
  if (presentada) {
    return {
      presentada: true,
      conEvidencia: false,
      origen: "manual",
      etiqueta: "marcada a mano — sin acuse",
      fecha: null,
      acuseDescargable: false,
    };
  }
  return {
    presentada: false,
    conEvidencia: false,
    origen: "ninguno",
    etiqueta: "sin presentar",
    fecha: null,
    acuseDescargable: false,
  };
}
