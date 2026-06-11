// ─────────────────────────────────────────────────────────────────────────────
// Naturaleza fiscal de un CFDI recibido — clasificación para deducibilidad.
//
// El CFDI recibido es REQUISITO de la deducción (Art. 27-III LISR) pero NO
// determina su momento ni su monto. La naturaleza decide CÓMO se deduce:
//
//   GASTO       → deducible en el periodo (Art. 25/27)              [G03, G02]
//   INVERSION   → activo fijo: vía DEPRECIACIÓN (Art. 31/34/36)     [I01–I08]
//   INVENTARIO  → vía COSTO DE LO VENDIDO al vender (Art. 39)       [G01]
//   SIN_EFECTOS → no deducible                                       [S01]
//
// El `usoCfdi` (lo que el RECEPTOR declaró al recibir la factura) es la señal
// primaria. OJO: el import asigna "G03" por defecto cuando el XML no lo trae,
// así que un G03 cuya mercancía PARECE activo fijo se marca para revisión en
// vez de confiar en el default.
//
// Este módulo es PURO y unit-testeable. NO toca el cálculo de impuestos: sólo
// produce la clasificación. Excluir las inversiones de las deducciones
// inmediatas debe hacerse JUNTO con el motor de depreciación (si no, se
// sub-deduce), por eso vive aparte.
//
// Espeja las reglas del asistente (src/lib/ai/system-prompt.ts, "Naturaleza
// fiscal de un CFDI") para que el motor y la IA coincidan.
// ─────────────────────────────────────────────────────────────────────────────

export type Naturaleza = "GASTO" | "INVERSION" | "INVENTARIO" | "SIN_EFECTOS";

export type SubtipoInversion =
  | "construccion"      // I01
  | "mobiliario"        // I02
  | "transporte"        // I03 (auto vs carga: ambiguo, ver clave)
  | "computo"           // I04
  | "herramental"       // I05
  | "comunicaciones"    // I06, I07
  | "maquinaria"        // I08
  | "otro";

export interface ClasificacionItem {
  claveProdServ: string;
  importe: number;
}

export interface ClasificacionCfdi {
  naturaleza: Naturaleza;
  /** De dónde salió: el usoCfdi declarado, el default G03, o no aplica (no EGRESO). */
  fuente: "usoCfdi" | "default" | "no_aplica";
  /** Fundamento legal del tratamiento. */
  fundamento: string;
  /** Para INVERSION: pista del tipo de activo (define tasa Art. 34 y tope Art. 36). */
  subtipoInversion?: SubtipoInversion;
  /** True cuando la señal no es concluyente o choca con la clave del producto. */
  requiereRevision: boolean;
  motivoRevision?: string;
  /**
   * Para vehículos: true si parece automóvil de pasajeros (tope MOI Art. 36-II
   * ~$175k). Las camionetas de CARGA/pickup NO son "automóvil" → sin tope.
   */
  posibleTopeAutomovil?: boolean;
}

// usoCfdi I01–I08 → subtipo de inversión.
const INVERSION_SUBTIPO: Record<string, SubtipoInversion> = {
  I01: "construccion",
  I02: "mobiliario",
  I03: "transporte",
  I04: "computo",
  I05: "herramental",
  I06: "comunicaciones",
  I07: "comunicaciones",
  I08: "maquinaria",
};

// Prefijos de ClaveProdServ que indican bienes de INVERSIÓN (para detectar
// G03 mal clasificados). El catálogo SAT agrupa por familia:
//   251xxxxx Vehículos de motor · 4321xxxx Equipo informático ·
//   24xxxxxx Maquinaria/manejo de materiales · 23xxxxxx Maquinaria industrial.
const CLAVE_INVERSION_PREFIJOS = ["251", "4321", "24", "23", "2510"];

// Vehículos de PASAJEROS (tope Art. 36-II) vs carga. Catálogo SAT:
//   25101500/25101600/25101900 automóviles · 25101800/25101700 camiones de carga,
//   pickups, tractocamiones (sin tope). Heurística por prefijo.
const CLAVE_AUTO_PASAJEROS = ["251015", "251016", "251019"];
const CLAVE_VEHICULO_CARGA = ["251017", "251018", "251020", "251021", "251022"];

function pareceInversion(items: ClasificacionItem[]): boolean {
  return items.some((it) => CLAVE_INVERSION_PREFIJOS.some((p) => it.claveProdServ?.startsWith(p)));
}

/** Detecta auto de pasajeros (tope) vs carga, por la clave dominante. */
function detectarTopeAutomovil(items: ClasificacionItem[]): boolean | undefined {
  const esCarga = items.some((it) => CLAVE_VEHICULO_CARGA.some((p) => it.claveProdServ?.startsWith(p)));
  if (esCarga) return false;
  const esAuto = items.some((it) => CLAVE_AUTO_PASAJEROS.some((p) => it.claveProdServ?.startsWith(p)));
  if (esAuto) return true;
  return undefined; // I03 genérico sin clave concluyente → desconocido
}

export interface ClasificarInput {
  /** Sólo se clasifican EGRESO (recibidos deducibles); el resto es no_aplica. */
  tipo: string;
  usoCfdi: string | null;
  /** Default G03 del import: cuando true y el uso es G03, no se confía a ciegas. */
  usoEsDefault?: boolean;
  items?: ClasificacionItem[];
}

/**
 * Clasifica la naturaleza fiscal de un CFDI recibido a partir de su usoCfdi
 * (señal primaria) y, como corroborador, las claves de producto.
 */
export function clasificarCfdi(input: ClasificarInput): ClasificacionCfdi {
  // Sólo los EGRESO (facturas recibidas) son potencialmente deducibles.
  if (input.tipo !== "EGRESO") {
    return { naturaleza: "GASTO", fuente: "no_aplica", fundamento: "", requiereRevision: false };
  }

  const uso = (input.usoCfdi ?? "").trim().toUpperCase();
  const items = input.items ?? [];

  // S01 — sin efectos fiscales → no deducible.
  if (uso === "S01") {
    return { naturaleza: "SIN_EFECTOS", fuente: "usoCfdi", fundamento: "CFDI sin efectos fiscales", requiereRevision: false };
  }

  // G01 — adquisición de mercancías → inventario (costo de lo vendido).
  if (uso === "G01") {
    return { naturaleza: "INVENTARIO", fuente: "usoCfdi", fundamento: "Art. 39 LISR (costo de lo vendido)", requiereRevision: false };
  }

  // I01–I08 — inversiones / activo fijo → depreciación.
  if (INVERSION_SUBTIPO[uso]) {
    const subtipo = INVERSION_SUBTIPO[uso];
    const out: ClasificacionCfdi = {
      naturaleza: "INVERSION",
      fuente: "usoCfdi",
      fundamento: "Art. 31 y 34 LISR (deducción de inversiones)",
      subtipoInversion: subtipo,
      requiereRevision: false,
    };
    if (subtipo === "transporte") {
      const tope = detectarTopeAutomovil(items);
      out.posibleTopeAutomovil = tope;
      if (tope === undefined) {
        out.requiereRevision = true;
        out.motivoRevision = "Equipo de transporte: confirma si es automóvil de pasajeros (tope MOI ~$175k, Art. 36-II) o vehículo de carga (sin tope).";
      } else if (tope) {
        out.fundamento = "Art. 31, 34 y 36-II LISR (automóvil: MOI deducible topado)";
      }
    }
    return out;
  }

  // G03 (o faltante → default) — gasto en general. Si el bien PARECE inversión,
  // no confiar en el default: marcar revisión.
  if (uso === "G03" || uso === "" || uso === "P01") {
    if (pareceInversion(items)) {
      return {
        naturaleza: "GASTO",
        fuente: input.usoEsDefault || uso === "" ? "default" : "usoCfdi",
        fundamento: "Art. 25/27 LISR (gasto deducible)",
        requiereRevision: true,
        motivoRevision: "El usoCfdi es G03 (gasto) pero la clave de producto parece activo fijo — revisa si debe depreciarse (Art. 31/34) en vez de deducirse de golpe.",
      };
    }
    return { naturaleza: "GASTO", fuente: input.usoEsDefault || uso === "" ? "default" : "usoCfdi", fundamento: "Art. 25/27 LISR (gasto deducible)", requiereRevision: false };
  }

  // G02 (devoluciones/descuentos) y D01–D10 (deducciones personales PF) y
  // cualquier otro → gasto por defecto, sin bandera (casos atípicos en CFDI de
  // empresa; el contador ajusta si aplica).
  return { naturaleza: "GASTO", fuente: "usoCfdi", fundamento: "Art. 25/27 LISR (gasto deducible)", requiereRevision: false };
}
