// ─────────────────────────────────────────────────────────────────────────────
// Farmacia derivada de los CFDIs (módulo HOSPITAL) — mismo contrato que
// auto-refaccion: «solo corre», idempotente, jamás postea al mayor.
//
//   • EGRESO (compra a proveedor) → alta del insumo (derivadoDeCfdi) y UNA
//     ENTRADA_COMPRA por (insumo, CFDI) con la cantidad sumada de sus líneas.
//   • INGRESO (venta al paciente/pagador) → SALIDA_VENTA sólo cuando ya existe
//     un insumo con esa clave. Nunca se da de alta un insumo desde una venta:
//     un hospital factura «Medicamentos» en un renglón y eso no es catálogo.
//
// Es «tanto como se pueda»: la salida derivada es parcial por diseño y el
// LOTE (caducidad) sólo existe cuando farmacia lo captura al recibir — un
// CFDI no trae lotes. Por eso los movimientos que nacen aquí llevan
// `loteId = null`, y la recepción de farmacia (POST /farmacia/lotes) ADOPTA
// ese movimiento en lugar de duplicarlo (ver esa ruta).
//
// Qué cuenta como insumo (clasificarInsumo): la clave del SAT manda cuando es
// específica —51 medicamentos, 42 material/equipo médico, 41 laboratorio— y
// cuando el emisor puso la genérica (01010101) o una clave ajena (46 guantes
// de seguridad, 12 alcohol), la descripción tiene que delatarlo: dosis (mg,
// mcg, UI), forma farmacéutica (tableta, ampolleta, sol. iny.), material
// (jeringa, gasa, sutura, catéter, guante, cubrebocas) o reactivo. Servicios
// (claves 78–95), rentas, honorarios, energía y demás NUNCA entran, digan lo
// que digan.
//
// Idempotencia: @@unique([insumoId, invoiceId, tipo]) en HospMovimientoInsumo
// — se escribe con createMany+skipDuplicates y el conteo dice si era nuevo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospInsumoCategoria, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** Job del cursor en BackfillProgreso (docs/HOSPITAL.md §4). */
export const JOB_INSUMOS = "hospital-insumos";

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Clasificación ───────────────────────────────────────────────────────────

export interface ConceptoInsumo {
  claveProdServ?: string | null;
  descripcion?: string | null;
}

export interface ClasificacionInsumo {
  esInsumo: boolean;
  categoria: HospInsumoCategoria;
}

/** Clave que el emisor pone cuando no clasifica: no dice nada del bien. */
export const CLAVE_GENERICA = "01010101";

/** Segmentos de SERVICIO del catálogo del SAT (78–95): ahí no hay un bien. */
const CLAVE_SERVICIO_RE = /^(7[89]|8[0-9]|9[0-5])/;

/**
 * Conceptos que jamás son un insumo aunque la clave o la descripción digan
 * «médico»: renta de equipo, honorarios del cirujano, luz del quirófano…
 */
const EXCLUIR_RE =
  /\b(RENTA|ARRENDAMIENTO|HONORARIOS?|ENERG[IÍ]A|ELECTRICIDAD|TEL[EÉ]FON[IO]A?|INTERNET|N[OÓ]MINA|ANTICIPO|INTER[EÉ]S(ES)?|COMISI[OÓ]N(ES)?|SEGUROS?|P[OÓ]LIZA|LICENCIA|SUSCRIPCI[OÓ]N|CAPACITACI[OÓ]N|CONSULTA|HOSPEDAJE|FLETE|SERVICIOS?\s+DE|MANTENIMIENTO|PUBLICIDAD|LIMPIEZA|HOSPITALIZACI[OÓ]N|CIRUG[IÍ]A)\b/i;

/**
 * Equipo (no consumible) dentro de 42/41. «EQUIPO DE VENOCLISIS» o «SET DE
 * INFUSIÓN» son material desechable, y «ELECTRODOS PARA MONITOR» es el
 * consumible del equipo, no el equipo — por eso las dos excepciones van antes.
 */
const SET_DESECHABLE_RE = /\b(EQUIPOS?|SETS?|KITS?)\s+(DE|PARA)\b/i;
const CONSUMIBLE_DE_EQUIPO_RE =
  /\b(PARA|DEL?)\s+(MONITOR|BOMBA|VENTILADOR|ASPIRADOR|DESFIBRILADOR|ELECTROCAUTERIO|AUTOCLAVE|ESTERILIZADOR|OX[IÍ]METRO)\b/i;
const EQUIPO_RE =
  /\b(EQUIPO|MONITOR(ES)?|BOMBAS?|VENTILADOR(ES)?|DESFIBRILADOR(ES)?|ELECTROCARDI[OÓ]GRAFO|ELECTROCAUTERIO|ESTERILIZADOR(ES)?|AUTOCLAVE|CAMILLAS?|CAMAS?|MESAS?|L[AÁ]MPARAS?|ASPIRADOR(ES)?|NEBULIZADOR(ES)?|INCUBADORAS?|INSTRUMENTAL|MICROSCOPIOS?|CENTR[IÍ]FUGAS?|ANALIZADOR(ES)?|ULTRASONIDO|EC[OÓ]GRAFO|RAYOS\s+X|OX[IÍ]METROS?|BAUMAN[OÓ]METROS?|ESFIGMOMAN[OÓ]METROS?|ESTETOSCOPIOS?|GLUC[OÓ]METROS?|SILLAS?\s+DE\s+RUEDAS|LARINGOSCOPIOS?|PINZAS?|TIJERAS?|PORTAAGUJAS|NEGATOSCOPIO|CONCENTRADOR)\b/i;

/** Solución parenteral: «SOLUCIÓN HARTMANN 1000 ML», «SOL. GLUCOSADA 5% 500ML». */
const SOLUCION_RE = /\b(SOLUCI[OÓ]N(ES)?|SOL\.?)\b/i;
const NOMBRE_SOLUCION_RE =
  /\b(HARTMANN|GLUCOSADA|SALINA|FISIOL[OÓ]GICA|RINGER|CLORURO\s+DE\s+SODIO|DEXTROSA|MIXTA|MANITOL)\b/i;
const VOLUMEN_RE = /\b(\d+(?:[.,]\d+)?)\s?(ML|MLS|L|LT|LTS|LITROS?)\b/i;
const INYECTABLE_RE = /\bINY(ECTABLE)?\b|\bI\.?M\.?\b|\bI\.?V\.?\b/i;

/** Dosis inequívocamente farmacológica (ml solo NO: «ALCOHOL 1000 ML» es material). */
const DOSIS_RE = /\b\d+(?:[.,]\d+)?\s?(MG|MCG|ΜG|UG|UI|U\.I\.|MEQ|MMOL)\b/i;
const FORMA_RE =
  /\b(TABLETAS?|TABS?|C[AÁ]PSULAS?|CAPS|COMPRIMIDOS?|AMPOLLETAS?|AMP|[AÁ]MPULAS?|FRASCO\s+[AÁ]MPULA|VIAL(ES)?|JARABE|SUSPENSI[OÓ]N|SUPOSITORIOS?|SOL\.?\s+INY\.?|SOLUCI[OÓ]N\s+INYECTABLE|INYECTABLE|GOTAS|UNG[UÜ]ENTO|POMADA|PARCHES?|GRAGEAS?|[OÓ]VULOS?|INHALADOR|AEROSOL|NEBULIZAR|VACUNA|INSULINA|ANEST[EÉ]SICO)\b/i;
const MATERIAL_RE =
  /\b(JERINGAS?|AGUJAS?|GASAS?|VENDAS?|SUTURAS?|CAT[EÉ]TER(ES)?|C[AÁ]NULAS?|GUANTES?|CUBREBOCAS|MASCARILLAS?|SONDAS?|AP[OÓ]SITOS?|ALGOD[OÓ]N|TELA\s+ADHESIVA|MICROPORE|TRANSPORE|BISTUR[IÍ]|HOJAS?\s+DE\s+BISTUR[IÍ]|ELECTRODOS?|VENOCLISIS|PUNZOCAT|BOLSAS?\s+(RECOLECTORA|DE\s+ORINA|DE\s+COLOSTOM[IÍ]A|PARA\s+ORINA)|CAMPOS?\s+QUIR[UÚ]RGICOS?|BATAS?\s+(DESECHABLES?|QUIR[UÚ]RGICAS?)|GORROS?|BOTAS?\s+QUIR[UÚ]RGICAS?|TORUNDAS?|HISOPOS?|ESPARADRAPO|ABATELENGUAS|LANCETAS?|YESO|F[EÉ]RULAS?|CINTA\s+(UMBILICAL|TESTIGO)|DREN(ES)?|PENROSE|TUBOS?\s+ENDOTRAQUEAL(ES)?|CIRCUITOS?\s+DE\s+ANESTESIA|LLAVE\s+DE\s+(3|TRES)\s+V[IÍ]AS|EXTENSI[OÓ]N\s+PARA\s+VENOCLISIS|EST[EÉ]RIL(ES)?|CURACI[OÓ]N|ALCOHOL|ISODINE|YODOPOVIDONA|CLORHEXIDINA|AGUA\s+OXIGENADA|BENZAL|JAB[OÓ]N\s+QUIR[UÚ]RGICO|GEL\s+ANTIBACTERIAL|GEL\s+PARA\s+ULTRASONIDO|COMPRESAS?|TAPABOCAS|MICROGOTERO|NORMOGOTERO|EQUIPO\s+DE\s+INFUSI[OÓ]N|BOLSA\s+PARA\s+SOLUCI[OÓ]N)\b/i;
const REACTIVO_RE =
  /\b(REACTIVOS?|KITS?\s+(DE|PARA)\s+(DETECCI[OÓ]N|DIAGN[OÓ]STICO|PRUEBAS?|ELISA|PCR|DETERMINACI[OÓ]N)|TIRAS?\s+REACTIVAS?|PRUEBAS?\s+R[AÁ]PIDAS?|CONTROL(ES)?\s+DE\s+CALIDAD|CALIBRADOR(ES)?|MEDIOS?\s+DE\s+CULTIVO|ANT[IÍ]GENOS?|ANTICUERPOS?|HEMOCULTIVO|TUBOS?\s+(DE\s+ENSAYO|VACUTAINER|AL\s+VAC[IÍ]O)|PORTAOBJETOS|CUBREOBJETOS|PIPETAS?|PUNTAS?\s+PARA\s+PIPETA)\b/i;

function esSolucion(desc: string): boolean {
  if (!(SOLUCION_RE.test(desc) || NOMBRE_SOLUCION_RE.test(desc))) return false;
  const vol = desc.match(VOLUMEN_RE);
  if (!vol) return false;
  // Una ampolleta de 1–20 ml también dice «sol. iny.»; la solución parenteral
  // que se cuelga es de 100 ml para arriba (o va en litros).
  const n = Number(vol[1].replace(",", "."));
  const enLitros = /^L/i.test(vol[2]);
  if (!enLitros && n < 100) return false;
  return !INYECTABLE_RE.test(desc) || NOMBRE_SOLUCION_RE.test(desc);
}

function esEquipo(desc: string): boolean {
  if (SET_DESECHABLE_RE.test(desc)) return false;
  if (CONSUMIBLE_DE_EQUIPO_RE.test(desc)) return false;
  return EQUIPO_RE.test(desc);
}

/**
 * ¿Este concepto es un insumo de farmacia/almacén, y de qué categoría?
 * Función pura (la que fija el test): la clave del SAT manda cuando es
 * específica; con clave genérica o ajena decide la descripción.
 */
export function clasificarInsumo(c: ConceptoInsumo): ClasificacionInsumo {
  const clave = (c.claveProdServ ?? "").trim();
  const desc = (c.descripcion ?? "").trim();
  const no = (): ClasificacionInsumo => ({ esInsumo: false, categoria: "OTRO" });
  const si = (categoria: HospInsumoCategoria): ClasificacionInsumo => ({ esInsumo: true, categoria });

  if (CLAVE_SERVICIO_RE.test(clave)) return no();
  if (EXCLUIR_RE.test(desc)) return no();

  // 51 — Medicamentos y productos farmacéuticos. Todo es medicamento salvo
  // la solución parenteral, que farmacia administra como categoría propia.
  if (clave.startsWith("51")) return si(esSolucion(desc) ? "SOLUCION" : "MEDICAMENTO");

  // 42 — Equipo, accesorios y suministros médicos. Material de curación por
  // default; equipo cuando la descripción lo dice; solución cuando es la bolsa.
  if (clave.startsWith("42")) {
    if (esSolucion(desc)) return si("SOLUCION");
    if (esEquipo(desc)) return si("EQUIPO");
    return si("MATERIAL_CURACION");
  }

  // 41 — Laboratorio: reactivos y kits salvo que sea el analizador/microscopio.
  if (clave.startsWith("41")) return si(esEquipo(desc) ? "EQUIPO" : "REACTIVO");

  // Clave genérica o ajena al ramo: sólo la descripción puede delatarlo, y
  // aquí NO se infiere equipo (un «monitor» bajo 43xx es una pantalla).
  if (!desc) return no();
  if (esSolucion(desc)) return si("SOLUCION");
  if (REACTIVO_RE.test(desc)) return si("REACTIVO");
  if (DOSIS_RE.test(desc) || FORMA_RE.test(desc)) return si("MEDICAMENTO");
  if (MATERIAL_RE.test(desc)) return si("MATERIAL_CURACION");
  return no();
}

/** Tasa de IVA con la que nace un insumo derivado: medicinas de patente y
 *  soluciones parenterales van a tasa 0 % (Art. 2-A-I-b LIVA); el material,
 *  el equipo y los reactivos gravan al 16 %. Farmacia lo puede corregir. */
export function ivaTasaDeCategoria(categoria: HospInsumoCategoria): number {
  return categoria === "MEDICAMENTO" || categoria === "SOLUCION" ? 0 : 0.16;
}

// ─── Clave estable ───────────────────────────────────────────────────────────

/** Identificadores genéricos que los emisores ponen en NoIdentificacion sin
 *  que sean códigos: con ellos la llave sería la misma para todo. */
const NO_IDENT_RUIDO = new Set([
  "N/A", "NA", "S/N", "SN", "0", "00", "-", "--", ".", "GENERICO", "GENÉRICO", "VARIOS",
  "SERVICIO", "MO", "NULL", "NONE", "X", CLAVE_GENERICA,
]);

/** MAYÚSCULAS, sin acentos, sólo alfanuméricos separados por un espacio. */
export function normalizarDescripcion(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Llave estable del insumo dentro de la empresa: el NoIdentificacion del
 * concepto cuando el emisor lo pone (código del proveedor, ≤ 40), si no la
 * descripción normalizada (≤ 60). Se sube a mayúsculas en ambos casos para
 * que «abc-1» y «ABC-1» no abran dos insumos. null = sin llave posible.
 */
export function claveDeInsumo(
  noIdentificacion: string | null | undefined,
  descripcion: string | null | undefined
): string | null {
  const ni = (noIdentificacion ?? "").trim();
  if (ni.length >= 2 && !NO_IDENT_RUIDO.has(ni.toUpperCase())) {
    return ni.toUpperCase().slice(0, 40);
  }
  const d = normalizarDescripcion(descripcion);
  return d ? d.slice(0, 60).trim() : null;
}

/** ClaveUnidad del SAT → unidad legible de farmacia. Lo que no se conoce es pieza. */
const UNIDADES: Record<string, string> = {
  H87: "pieza", EA: "pieza", C62: "pieza", XUN: "pieza", E48: "servicio",
  XBX: "caja", XCS: "caja", XCT: "caja", XPK: "paquete", XPA: "paquete",
  XBG: "bolsa", XBO: "botella", XVI: "vial", XAM: "ampolleta", XTU: "tubo",
  XRO: "rollo", XSA: "saco", XBJ: "cubeta", XCA: "lata", XST: "hoja",
  XDR: "tambor", XJR: "frasco", XPX: "tarima", SET: "juego", KT: "kit",
  PR: "par", DZN: "docena", LTR: "litro", MLT: "mililitro", GRM: "gramo",
  KGM: "kilogramo", MGM: "miligramo", MTR: "metro", CMT: "centímetro", MTK: "m²",
};
export function unidadDesdeClaveUnidad(claveUnidad: string | null | undefined): string {
  const k = (claveUnidad ?? "").trim().toUpperCase();
  return UNIDADES[k] ?? "pieza";
}

/** Entidades XML básicas → texto, sólo para el NOMBRE que se enseña. */
function decodificarEntidades(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ─── Conceptos del XML (para el NoIdentificacion que InvoiceItem no guarda) ──

export interface ConceptoXml {
  noIdentificacion: string | null;
  claveProdServ: string | null;
  claveUnidad: string | null;
  descripcion: string;
  cantidad: number;
  valorUnitario: number;
  importe: number;
}

const CONCEPTO_RE = /<(?:[\w-]+:)?Concepto\b([^>]*?)(?:\/>|>)/gi;
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
};

/** Conceptos del CFDI tal como vienen (sin decodificar entidades: igual que
 *  cfdi-import guarda la descripción, para que las llaves empaten). */
export function extraerConceptosCfdi(rawXml: string): ConceptoXml[] {
  const out: ConceptoXml[] = [];
  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    const cantidad = Number(attr(attrs, "Cantidad") ?? "1");
    const valorUnitario = Number(attr(attrs, "ValorUnitario") ?? "0");
    const importe = Number(attr(attrs, "Importe") ?? "0");
    out.push({
      noIdentificacion: attr(attrs, "NoIdentificacion"),
      claveProdServ: attr(attrs, "ClaveProdServ"),
      claveUnidad: attr(attrs, "ClaveUnidad"),
      descripcion: attr(attrs, "Descripcion") ?? "",
      cantidad: Number.isFinite(cantidad) ? cantidad : 1,
      valorUnitario: Number.isFinite(valorUnitario) ? valorUnitario : 0,
      importe: Number.isFinite(importe) ? importe : 0,
    });
  }
  return out;
}

// ─── Derivación de un CFDI ───────────────────────────────────────────────────

export interface LineaCfdiInsumo {
  descripcion: string;
  cantidad: number;
  claveUnidad?: string | null;
  claveProdServ?: string | null;
  valorUnitario: number;
  importe: number;
  /** Lo trae el XML, no InvoiceItem; si viene undefined se busca en rawXml. */
  noIdentificacion?: string | null;
}

export interface DerivarInsumosArgs {
  companyId: string;
  invoiceId: string;
  /** Invoice.tipo */
  tipo: string;
  /** Invoice.tipoSat — "E" (nota de crédito) netea dinero, no mueve kardex. */
  tipoSat: string | null;
  fecha: Date;
  items: LineaCfdiInsumo[];
  rawXml?: string | null;
}

export interface DerivarInsumosResultado {
  /** Insumos dados de alta (nuevos) por este CFDI. */
  insumos: number;
  /** Movimientos de kardex escritos (0 si el CFDI ya estaba derivado). */
  movimientos: number;
}

const llaveLinea = (descripcion: string, cantidad: number, importe: number) =>
  `${normalizarDescripcion(descripcion)}|${Math.round(cantidad * 1e6)}|${Math.round(importe * 100)}`;

/**
 * Líneas a derivar: las de InvoiceItem, enriquecidas con el NoIdentificacion
 * del XML (empatado por descripción + cantidad + importe, no por posición: el
 * parser del hub descarta conceptos malformados y correría la numeración).
 * Si la factura no guardó items, los conceptos del XML son las líneas.
 */
function prepararLineas(items: LineaCfdiInsumo[], rawXml: string | null | undefined): LineaCfdiInsumo[] {
  const lineas = items.map((it) => ({
    ...it,
    cantidad: Number(it.cantidad),
    valorUnitario: Number(it.valorUnitario),
    importe: Number(it.importe),
  }));
  if (!rawXml) return lineas;
  const conceptos = extraerConceptosCfdi(rawXml);
  if (lineas.length === 0) {
    return conceptos.map((c) => ({
      descripcion: c.descripcion,
      cantidad: c.cantidad,
      claveUnidad: c.claveUnidad,
      claveProdServ: c.claveProdServ,
      valorUnitario: c.valorUnitario,
      importe: c.importe,
      noIdentificacion: c.noIdentificacion,
    }));
  }
  if (lineas.every((l) => l.noIdentificacion !== undefined)) return lineas;
  const porLlave = new Map<string, string | null>();
  for (const c of conceptos) {
    const k = llaveLinea(c.descripcion, c.cantidad, c.importe);
    if (!porLlave.has(k)) porLlave.set(k, c.noIdentificacion);
  }
  return lineas.map((l) =>
    l.noIdentificacion !== undefined
      ? l
      : { ...l, noIdentificacion: porLlave.get(llaveLinea(l.descripcion, l.cantidad, l.importe)) ?? null }
  );
}

interface AgregadoCompra {
  clave: string;
  descripcion: string;
  claveProdServ: string | null;
  claveUnidad: string | null;
  categoria: HospInsumoCategoria;
  cantidad: number;
  monto: number;
}

/**
 * Deriva catálogo + kardex de UN CFDI. Sólo INGRESO/EGRESO que no sean nota de
 * crédito; devuelve ceros (nunca lanza) cuando no aplica.
 */
export async function derivarInsumosDesdeCfdi(
  db: Db,
  args: DerivarInsumosArgs
): Promise<DerivarInsumosResultado> {
  const vacio: DerivarInsumosResultado = { insumos: 0, movimientos: 0 };
  if (args.tipo !== "INGRESO" && args.tipo !== "EGRESO") return vacio;
  if ((args.tipoSat ?? "I") === "E") return vacio;

  const lineas = prepararLineas(args.items, args.rawXml).filter((l) => l.cantidad > 0);
  if (lineas.length === 0) return vacio;

  return args.tipo === "EGRESO" ? derivarCompra(db, args, lineas) : derivarVenta(db, args, lineas);
}

async function derivarCompra(
  db: Db,
  args: DerivarInsumosArgs,
  lineas: LineaCfdiInsumo[]
): Promise<DerivarInsumosResultado> {
  // Líneas repetidas del mismo insumo se agregan: cantidad sumada, costo
  // promedio ponderado — un movimiento por (insumo, CFDI).
  const porClave = new Map<string, AgregadoCompra>();
  for (const l of lineas) {
    const { esInsumo, categoria } = clasificarInsumo(l);
    if (!esInsumo) continue;
    const clave = claveDeInsumo(l.noIdentificacion, l.descripcion);
    if (!clave) continue;
    const monto = l.valorUnitario > 0 ? l.valorUnitario * l.cantidad : l.importe;
    const prev = porClave.get(clave);
    if (prev) {
      prev.cantidad += l.cantidad;
      prev.monto += monto;
    } else {
      porClave.set(clave, {
        clave,
        descripcion: l.descripcion,
        claveProdServ: l.claveProdServ ?? null,
        claveUnidad: l.claveUnidad ?? null,
        categoria,
        cantidad: l.cantidad,
        monto,
      });
    }
  }
  if (porClave.size === 0) return { insumos: 0, movimientos: 0 };

  let insumos = 0;
  let movimientos = 0;
  for (const a of porClave.values()) {
    const costo = a.cantidad > 0 ? r2(a.monto / a.cantidad) : null;
    const nombre = decodificarEntidades(a.descripcion).trim().slice(0, 200) || a.clave;

    let existente = await db.hospInsumo.findUnique({
      where: { companyId_clave: { companyId: args.companyId, clave: a.clave } },
      select: {
        id: true,
        movimientos: {
          where: { tipo: "ENTRADA_COMPRA" },
          orderBy: { fecha: "desc" },
          take: 1,
          select: { fecha: true },
        },
      },
    });
    let insumoId: string;
    if (!existente) {
      try {
        const creado = await db.hospInsumo.create({
          data: {
            companyId: args.companyId,
            clave: a.clave,
            nombre,
            unidad: unidadDesdeClaveUnidad(a.claveUnidad),
            categoria: a.categoria,
            ultimoCosto: costo,
            ivaTasa: ivaTasaDeCategoria(a.categoria),
            claveProdServ: a.claveProdServ,
            derivadoDeCfdi: true,
          },
          select: { id: true },
        });
        insumoId = creado.id;
        insumos++;
      } catch {
        // Carrera con otra derivación (import inline + cron) sobre la misma
        // clave: el otro ganó el @@unique; se lee y se sigue.
        existente = await db.hospInsumo.findUnique({
          where: { companyId_clave: { companyId: args.companyId, clave: a.clave } },
          select: { id: true, movimientos: { where: { tipo: "ENTRADA_COMPRA" }, orderBy: { fecha: "desc" }, take: 1, select: { fecha: true } } },
        });
        if (!existente) throw new Error(`No se pudo dar de alta el insumo ${a.clave}`);
        insumoId = existente.id;
      }
    } else {
      insumoId = existente.id;
    }

    if (existente) {
      // «Último costo» es el de la compra MÁS RECIENTE por fecha, no la última
      // que pasó por aquí: el backfill barre por id y el archivo llega en
      // desorden (SAT primero, Syntage con los años viejos después).
      const ultima = existente.movimientos[0]?.fecha;
      if (costo != null && (!ultima || args.fecha.getTime() >= new Date(ultima).getTime())) {
        await db.hospInsumo.update({
          where: { id: insumoId },
          data: { ultimoCosto: costo, ...(a.claveProdServ ? { claveProdServ: a.claveProdServ } : {}) },
        });
      }
    }

    const { count } = await db.hospMovimientoInsumo.createMany({
      data: [
        {
          companyId: args.companyId,
          insumoId,
          loteId: null,
          tipo: "ENTRADA_COMPRA",
          cantidad: a.cantidad,
          costoUnitario: costo,
          fecha: args.fecha,
          invoiceId: args.invoiceId,
        },
      ],
      skipDuplicates: true,
    });
    movimientos += count;
  }
  return { insumos, movimientos };
}

async function derivarVenta(
  db: Db,
  args: DerivarInsumosArgs,
  lineas: LineaCfdiInsumo[]
): Promise<DerivarInsumosResultado> {
  // Tres formas de empatar la línea con el catálogo, en orden: el código que
  // puso el hospital (NoIdentificacion), la descripción normalizada como
  // clave, y la descripción normalizada contra el NOMBRE del insumo — que es
  // como quedó cuando la compra traía código de proveedor y el hospital vende
  // con la misma descripción pero sin código. Sin empate no hay salida (nunca
  // se crea un insumo desde una venta).
  const candidatas = lineas.map((l) => ({
    linea: l,
    claves: [...new Set([claveDeInsumo(l.noIdentificacion, l.descripcion), claveDeInsumo(null, l.descripcion)].filter((c): c is string => !!c))],
    nombreNorm: normalizarDescripcion(decodificarEntidades(l.descripcion)),
  }));
  const todas = [...new Set(candidatas.flatMap((c) => c.claves))];
  const nombres = [...new Set(candidatas.map((c) => decodificarEntidades(c.linea.descripcion).trim().slice(0, 200)).filter(Boolean))];
  if (todas.length === 0 && nombres.length === 0) return { insumos: 0, movimientos: 0 };

  const existentes = await db.hospInsumo.findMany({
    where: {
      companyId: args.companyId,
      OR: [
        ...(todas.length ? [{ clave: { in: todas } }] : []),
        ...(nombres.length ? [{ nombre: { in: nombres, mode: "insensitive" as const } }] : []),
      ],
    },
    select: {
      id: true,
      clave: true,
      nombre: true,
      ultimoCosto: true,
      movimientos: { where: { tipo: "SALIDA_VENTA" }, orderBy: { fecha: "desc" }, take: 1, select: { fecha: true } },
    },
  });
  if (existentes.length === 0) return { insumos: 0, movimientos: 0 };
  const porClave = new Map(existentes.map((i) => [i.clave, i]));
  const porNombre = new Map(existentes.map((i) => [normalizarDescripcion(i.nombre), i]));

  const porInsumo = new Map<string, { insumo: (typeof existentes)[number]; cantidad: number; monto: number }>();
  for (const c of candidatas) {
    const insumo =
      c.claves.map((k) => porClave.get(k)).find((i) => i != null) ??
      (c.nombreNorm ? porNombre.get(c.nombreNorm) : undefined);
    if (!insumo) continue;
    const monto = c.linea.valorUnitario > 0 ? c.linea.valorUnitario * c.linea.cantidad : c.linea.importe;
    const prev = porInsumo.get(insumo.id);
    if (prev) {
      prev.cantidad += c.linea.cantidad;
      prev.monto += monto;
    } else {
      porInsumo.set(insumo.id, { insumo, cantidad: c.linea.cantidad, monto });
    }
  }

  let movimientos = 0;
  for (const v of porInsumo.values()) {
    const { count } = await db.hospMovimientoInsumo.createMany({
      data: [
        {
          companyId: args.companyId,
          insumoId: v.insumo.id,
          loteId: null,
          tipo: "SALIDA_VENTA",
          cantidad: -v.cantidad,
          // La salida se valúa al último costo conocido; el precio de venta
          // queda en el insumo, no en el kardex.
          costoUnitario: v.insumo.ultimoCosto == null ? null : Number(v.insumo.ultimoCosto),
          fecha: args.fecha,
          invoiceId: args.invoiceId,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) continue;
    movimientos += count;
    const ultima = v.insumo.movimientos[0]?.fecha;
    if (v.cantidad > 0 && (!ultima || args.fecha.getTime() >= new Date(ultima).getTime())) {
      await db.hospInsumo.update({
        where: { id: v.insumo.id },
        data: { precioVenta: r2(v.monto / v.cantidad) },
      });
    }
  }
  return { insumos: 0, movimientos };
}

// ─── Progreso del drenado (job "hospital-insumos") ───────────────────────────
//
// backfill-progreso.ts del vertical automotriz fija el tipo BackfillJob a sus
// tres jobs y `empresasPendientes` filtra por AUTOMOTRIZ, así que aquí viven
// los equivalentes para HOSPITAL sobre la misma tabla BackfillProgreso.

export interface ProgresoInsumos {
  cursor: string | null;
  procesados: number;
  derivados: number;
  completado: boolean;
  completadoAt: Date | null;
  updatedAt: Date | null;
}

export async function leerProgresoInsumos(db: Db, companyId: string): Promise<ProgresoInsumos> {
  const row = await db.backfillProgreso.findUnique({
    where: { companyId_job: { companyId, job: JOB_INSUMOS } },
    select: { cursor: true, procesados: true, derivados: true, completadoAt: true, updatedAt: true },
  });
  return {
    cursor: row?.cursor ?? null,
    procesados: row?.procesados ?? 0,
    derivados: row?.derivados ?? 0,
    completado: row?.completadoAt != null,
    completadoAt: row?.completadoAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function guardarProgresoInsumos(
  db: Db,
  companyId: string,
  datos: { cursor: string | null; procesados: number; derivados: number; completado: boolean }
): Promise<void> {
  const comun = { cursor: datos.cursor, completadoAt: datos.completado ? new Date() : null };
  await db.backfillProgreso.upsert({
    where: { companyId_job: { companyId, job: JOB_INSUMOS } },
    create: { companyId, job: JOB_INSUMOS, ...comun, procesados: datos.procesados, derivados: datos.derivados },
    update: { ...comun, procesados: { increment: datos.procesados }, derivados: { increment: datos.derivados } },
  });
}

export async function reiniciarProgresoInsumos(db: Db, companyId: string): Promise<void> {
  await db.backfillProgreso.upsert({
    where: { companyId_job: { companyId, job: JOB_INSUMOS } },
    create: { companyId, job: JOB_INSUMOS },
    update: { cursor: null, procesados: 0, derivados: 0, completadoAt: null },
  });
}

/**
 * Empresas con el módulo HOSPITAL, en el orden en que el cron debe atenderlas:
 * primero las que no han terminado su carga inicial (la más antigua antes),
 * después las terminadas por la que lleva más tiempo sin revisarse. Las
 * terminadas también entran: el cursor por id sigue hacia adelante y recoge
 * lo importado después (la derivación es idempotente, así que cuesta poco).
 */
export async function empresasHospitalParaBackfill(db: Db, limite = 5): Promise<string[]> {
  const companies = await db.company.findMany({
    where: { modules: { some: { modulo: "HOSPITAL", habilitado: true } } },
    select: {
      id: true,
      createdAt: true,
      backfillProgreso: { where: { job: JOB_INSUMOS }, select: { completadoAt: true, updatedAt: true } },
    },
  });
  const rango = (c: (typeof companies)[number]) => {
    const p = c.backfillProgreso[0];
    const pendiente = !p || p.completadoAt == null;
    return { pendiente, t: (p?.updatedAt ?? c.createdAt).getTime() };
  };
  return companies
    .sort((a, b) => {
      const ra = rango(a);
      const rb = rango(b);
      if (ra.pendiente !== rb.pendiente) return ra.pendiente ? -1 : 1;
      return ra.t - rb.t;
    })
    .slice(0, limite)
    .map((c) => c.id);
}

// ─── Backfill por cursor ─────────────────────────────────────────────────────

export interface BackfillInsumosOpciones {
  /** Cursor explícito (id de la última factura procesada). undefined = el guardado. */
  afterId?: string | null;
  /** Presupuesto de tiempo por corrida. */
  budgetMs?: number;
  /** Facturas por página. */
  page?: number;
  /** Gancho por página (p. ej. borrar lo derivado antes de rederivar). */
  antesDePagina?: (invoiceIds: string[]) => Promise<void>;
}

export interface BackfillInsumosResultado {
  procesados: number;
  insumos: number;
  movimientos: number;
  nextAfterId: string | null;
  completado: boolean;
  elapsedMs: number;
}

/**
 * Una corrida acotada del drenado: recorre los CFDIs INGRESO/EGRESO de la
 * empresa por id ascendente desde el cursor y deriva cada uno. Guarda el
 * avance en BackfillProgreso (job hospital-insumos) al terminar.
 *
 * Qué se lee por página: los InvoiceItem (ligeros). El rawXml — pesado — sólo
 * se pide para las facturas que tienen AL MENOS una línea que clasifica como
 * insumo (o que no guardaron items): es el único caso en que el
 * NoIdentificacion del XML cambia la llave. Las facturas de renta, honorarios
 * y servicios, que son la mayoría del archivo, nunca cargan su XML.
 */
export async function derivarInsumosBackfill(
  db: Db,
  companyId: string,
  opts: BackfillInsumosOpciones = {}
): Promise<BackfillInsumosResultado> {
  const budgetMs = opts.budgetMs ?? 20_000;
  const page = opts.page ?? 100;
  const startedAt = Date.now();

  let cursor: string | null;
  if (opts.afterId !== undefined) {
    cursor = opts.afterId;
  } else {
    cursor = (await leerProgresoInsumos(db, companyId)).cursor;
  }

  let procesados = 0;
  let insumos = 0;
  let movimientos = 0;
  let completado = true;

  while (true) {
    if (Date.now() - startedAt >= budgetMs) {
      completado = false;
      break;
    }
    const lote = await db.invoice.findMany({
      where: {
        companyId,
        tipo: { in: ["INGRESO", "EGRESO"] },
        status: { not: "CANCELLED" },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: page,
      select: {
        id: true,
        tipo: true,
        tipoSat: true,
        fecha: true,
        items: {
          select: {
            descripcion: true,
            cantidad: true,
            claveUnidad: true,
            claveProdServ: true,
            valorUnitario: true,
            importe: true,
          },
        },
      },
    });
    if (lote.length === 0) break;

    if (opts.antesDePagina) await opts.antesDePagina(lote.map((i) => i.id));

    const necesitanXml = lote
      .filter((inv) => inv.items.length === 0 || inv.items.some((it) => clasificarInsumo(it).esInsumo))
      .map((inv) => inv.id);
    const xml = new Map<string, string | null>();
    if (necesitanXml.length > 0) {
      const filas = await db.invoice.findMany({
        where: { id: { in: necesitanXml } },
        select: { id: true, rawXml: true },
      });
      for (const f of filas) xml.set(f.id, f.rawXml);
    }

    for (const inv of lote) {
      procesados++;
      const r = await derivarInsumosDesdeCfdi(db, {
        companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        tipoSat: inv.tipoSat,
        fecha: inv.fecha,
        items: inv.items.map((it) => ({
          descripcion: it.descripcion,
          cantidad: Number(it.cantidad),
          claveUnidad: it.claveUnidad,
          claveProdServ: it.claveProdServ,
          valorUnitario: Number(it.valorUnitario),
          importe: Number(it.importe),
        })),
        rawXml: xml.get(inv.id) ?? null,
      });
      insumos += r.insumos;
      movimientos += r.movimientos;
    }

    cursor = lote[lote.length - 1].id;
    if (lote.length < page) break;
  }

  await guardarProgresoInsumos(db, companyId, { cursor, procesados, derivados: movimientos, completado });

  return {
    procesados,
    insumos,
    movimientos,
    nextAfterId: completado ? null : cursor,
    completado,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Conteos de lo derivado, para Configuración y GET /farmacia/derivar. */
export async function conteosDerivacion(db: Db, companyId: string) {
  const [insumosDerivados, movimientosDerivados] = await Promise.all([
    db.hospInsumo.count({ where: { companyId, derivadoDeCfdi: true } }),
    db.hospMovimientoInsumo.count({
      where: { companyId, invoiceId: { not: null }, tipo: { in: ["ENTRADA_COMPRA", "SALIDA_VENTA"] } },
    }),
  ]);
  return { insumosDerivados, movimientosDerivados };
}

// ─── Derivación INLINE (sat-sync / import-cfdi) ───────────────────────────────

// Cache del gate de módulo: el sync procesa miles de CFDIs por corrida y el
// módulo de una empresa casi nunca cambia (mismo patrón que auto-vehiculo).
const moduloCache = new Map<string, { habilitado: boolean; t: number }>();
const MODULO_TTL_MS = 5 * 60_000;

/**
 * Derivación al importar: igual que derivarInsumosDesdeCfdi pero sólo si la
 * empresa tiene el módulo HOSPITAL habilitado. Nunca revienta el import: un
 * fallo aquí se registra y el cron hospital-insumos-backfill lo recoge después.
 */
export async function derivarInsumosInline(
  db: Db,
  args: DerivarInsumosArgs
): Promise<DerivarInsumosResultado | null> {
  if (args.tipo !== "INGRESO" && args.tipo !== "EGRESO") return null;
  const cached = moduloCache.get(args.companyId);
  let habilitado: boolean;
  if (cached && Date.now() - cached.t < MODULO_TTL_MS) {
    habilitado = cached.habilitado;
  } else {
    habilitado = !!(await db.companyModule.findFirst({
      where: { companyId: args.companyId, modulo: "HOSPITAL", habilitado: true },
      select: { id: true },
    }));
    moduloCache.set(args.companyId, { habilitado, t: Date.now() });
  }
  if (!habilitado) return null;
  try {
    return await derivarInsumosDesdeCfdi(db, args);
  } catch (e) {
    console.error(`[hospital] derivación inline de insumos falló para ${args.invoiceId}:`, e);
    return null;
  }
}
