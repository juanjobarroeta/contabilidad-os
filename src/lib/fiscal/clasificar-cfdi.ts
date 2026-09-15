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
  | "intangible"        // software, licencias: se AMORTIZA (Art. 33), no se deprecia
  | "otro";

export interface ClasificacionItem {
  claveProdServ: string;
  importe: number;
  /** Para nombrar el activo cuando la factura trae varios conceptos. */
  descripcion?: string | null;
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
// Software y licencias. El catálogo del SAT los agrupa en 43230000
// («Software»): 432315xx aplicaciones y negocios, 432320xx sistemas
// operativos, 432321xx herramientas de desarrollo… Un bien de estos NO se
// deprecia: se amortiza (Art. 33), en otra cuenta y a otra tasa.
// SÓLO la familia 4323 («Software»). 81112 —servicios de tecnologías de
// información— estuvo aquí un rato y fue un error de los caros: un servicio no
// es un activo intangible, es gasto del periodo, y de paso arrastró hardware
// mal clasificado por el vendedor (un servidor Dell facturado bajo servicios).
const CLAVE_INTANGIBLE_PREFIJOS = ["4323"];

/**
 * Por debajo de esto, una «inversión» casi siempre es un consumible que alguien
 * facturó con uso I0x: un cable, una memoria, un teclado. NO es un umbral legal
 * —la LISR no tiene monto mínimo para capitalizar— sino una señal para que lo
 * mire una persona antes de depreciar tres años un gasto del mes.
 */
export const MONTO_REVISION_INVERSION = 5000;

const CLAVE_AUTO_PASAJEROS = ["251015", "251016", "251019"];
const CLAVE_VEHICULO_CARGA = ["251017", "251018", "251020", "251021", "251022"];

function pareceIntangible(items: ClasificacionItem[]): boolean {
  return items.some((it) => CLAVE_INTANGIBLE_PREFIJOS.some((p) => it.claveProdServ?.startsWith(p)));
}

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
  /** Tipo de comprobante del SAT: «E» es NOTA DE CRÉDITO — resta, no suma. */
  tipoSat?: string | null;
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

  // UNA NOTA DE CRÉDITO NO ES UNA INVERSIÓN, AUNQUE DIGA I04.
  //
  // El esquema de anticipos del SAT (Anexo 20, apéndice 6) son TRES CFDIs: el
  // anticipo, el de la operación total, y una nota de crédito (tipo «E») que
  // aplica el anticipo para que no se cobre dos veces. Los tres llevan el mismo
  // usoCfdi, así que los tres creaban activo. Visto en CENTRO: una compra de
  // $26,650.87 quedó como tres activos de ~$26,650 depreciándose en paralelo,
  // uno de ellos llamado «APLICACION ANTICIPO» — el que debía RESTAR.
  if ((input.tipoSat ?? "").trim().toUpperCase() === "E") {
    return {
      naturaleza: "GASTO",
      fuente: "usoCfdi",
      fundamento: "Nota de crédito (CFDI de egreso): disminuye la operación, no la crea",
      requiereRevision: false,
    };
  }

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

    // EL GUARDIA QUE FALTABA, DEL OTRO LADO. Un G03 cuya clave parece activo ya
    // se marcaba; un I0x cuya clave parece software o cuyo importe parece un
    // consumible, no se cuestionaba nunca. Por ahí entraban una licencia al
    // 30 % como equipo de cómputo y una memoria USB depreciándose tres años.
    if (pareceIntangible(items)) {
      out.subtipoInversion = "intangible";
      out.fundamento = "Art. 33 LISR (amortización de gastos diferidos)";
      out.requiereRevision = true;
      out.motivoRevision =
        "La clave de producto dice software o licencia: eso se AMORTIZA (Art. 33), no se deprecia. Confirma si es licencia perpetua (cargo diferido 5 %), gasto diferido (15 %) o una suscripción del periodo, que no es activo.";
      return out;
    }

    const importe = items.reduce((s, it) => s + (Number(it.importe) || 0), 0);
    if (importe > 0 && importe < MONTO_REVISION_INVERSION) {
      out.requiereRevision = true;
      out.motivoRevision = `El uso dice inversión pero el importe es de $${importe.toFixed(2)}: confirma que sea un activo y no un consumible del periodo.`;
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// UNA FACTURA, VARIOS ACTIVOS.
//
// El registro automático tomaba el subtotal COMPLETO del CFDI y el nombre del
// primer renglón: una factura con laptop, licencia y memoria quedaba como UN
// activo llamado «Laptop» por el total, depreciándose todo al 30 %. La licencia
// se amortiza al 15 % y en otra cuenta, y la memoria probablemente ni es activo.
//
// Se parte por TRATAMIENTO, no por renglón. Partir por renglón llenaría el
// registro de basura —«Flete», «Instalación», «Garantía extendida» como activos
// sueltos— cuando esos costos son parte del MOI del bien que acompañan
// (Art. 31 LISR: el monto original incluye fletes, seguros, instalación).
//
// Entonces: los renglones cuya clave dice de qué bien se trata forman un grupo
// por tipo; los que no lo dicen se suman al grupo más grande, que es donde
// contablemente pertenecen. Con un solo tipo, sale un activo por el subtotal
// entero — exactamente lo de antes.
// ─────────────────────────────────────────────────────────────────────────────

export interface GrupoInversion {
  subtipo: SubtipoInversion;
  /** MOI del grupo: sus renglones más la parte proporcional de lo accesorio. */
  importe: number;
  descripcion: string;
  requiereRevision: boolean;
  motivoRevision?: string;
}

/** El tipo de bien que declara la clave del renglón, o null si no lo dice. */
function subtipoDeClave(clave: string | null | undefined): SubtipoInversion | null {
  const c = (clave ?? "").trim();
  if (!c) return null;
  if (CLAVE_INTANGIBLE_PREFIJOS.some((p) => c.startsWith(p))) return "intangible";
  if (c.startsWith("251")) return "transporte";
  if (c.startsWith("4321")) return "computo";
  if (c.startsWith("24") || c.startsWith("23")) return "maquinaria";
  return null;
}

/**
 * Los activos que salen de un CFDI de inversión. Vacío si no es inversión.
 * `subtipoDeclarado` es el del usoCfdi: manda cuando las claves no dicen nada.
 */
export function partirInversionPorConcepto(
  subtipoDeclarado: SubtipoInversion,
  items: ClasificacionItem[],
  subtotal: number,
): GrupoInversion[] {
  const conTipo = items
    .map((it) => ({ ...it, subtipo: subtipoDeClave(it.claveProdServ), importe: Number(it.importe) || 0 }))
    .filter((it) => it.importe > 0);

  const tipos = new Set(conTipo.map((it) => it.subtipo).filter((t): t is SubtipoInversion => t !== null));

  // Ningún renglón dice qué es, o todos dicen lo mismo: un activo por el
  // subtotal entero (con lo accesorio dentro, que es donde va).
  if (tipos.size <= 1) {
    const subtipo = [...tipos][0] ?? subtipoDeclarado;
    return [
      {
        subtipo,
        importe: subtotal,
        descripcion: nombreDelGrupo(conTipo) || "Inversión (CFDI)",
        ...banderas(subtipo, subtotal),
      },
    ];
  }

  // Varios tratamientos en la misma factura. Lo accesorio —fletes, instalación,
  // lo que la clave no identifica— se va con el grupo más grande: es parte de
  // su monto original, no un activo aparte.
  const porTipo = new Map<SubtipoInversion, typeof conTipo>();
  let accesorio = 0;
  for (const it of conTipo) {
    if (!it.subtipo) { accesorio += it.importe; continue; }
    porTipo.set(it.subtipo, [...(porTipo.get(it.subtipo) ?? []), it]);
  }

  const grupos = [...porTipo.entries()].map(([subtipo, renglones]) => ({
    subtipo,
    importe: renglones.reduce((s, it) => s + it.importe, 0),
    renglones,
  }));
  grupos.sort((a, b) => b.importe - a.importe);
  if (accesorio > 0 && grupos.length > 0) grupos[0].importe += accesorio;

  // El redondeo no puede perder ni inventar dinero: el mayor absorbe la
  // diferencia contra el subtotal del CFDI (descuentos, centavos).
  const suma = grupos.reduce((s, g) => s + g.importe, 0);
  const dif = Math.round((subtotal - suma) * 100) / 100;
  if (dif !== 0 && grupos.length > 0) grupos[0].importe = Math.round((grupos[0].importe + dif) * 100) / 100;

  return grupos.map((g) => ({
    subtipo: g.subtipo,
    importe: Math.round(g.importe * 100) / 100,
    descripcion: nombreDelGrupo(g.renglones) || "Inversión (CFDI)",
    ...banderas(g.subtipo, g.importe),
  }));
}

/** El renglón más grande da el nombre; si hay más, se dice cuántos. */
function nombreDelGrupo(renglones: Array<{ importe: number; descripcion?: string | null }>): string {
  if (renglones.length === 0) return "";
  const mayor = renglones.reduce((a, b) => (b.importe > a.importe ? b : a));
  const base = (mayor.descripcion ?? "").trim();
  if (!base) return "";
  return renglones.length > 1 ? `${base} y ${renglones.length - 1} concepto(s) más` : base;
}

function banderas(subtipo: SubtipoInversion, importe: number): { requiereRevision: boolean; motivoRevision?: string } {
  if (subtipo === "intangible") {
    return {
      requiereRevision: true,
      motivoRevision:
        "La clave de producto dice software o licencia: eso se AMORTIZA (Art. 33), no se deprecia. Confirma si es licencia perpetua (cargo diferido 5 %), gasto diferido (15 %) o una suscripción del periodo, que no es activo.",
    };
  }
  if (importe > 0 && importe < MONTO_REVISION_INVERSION) {
    return {
      requiereRevision: true,
      motivoRevision: `El uso dice inversión pero el importe es de $${importe.toFixed(2)}: confirma que sea un activo y no un consumible del periodo.`,
    };
  }
  return { requiereRevision: false };
}
