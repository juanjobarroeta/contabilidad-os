// ─────────────────────────────────────────────────────────────────────────────
// Extracción de datos de vehículo desde un CFDI (rawXml).
//
// Fuente primaria y confiable: el Complemento de Venta de Vehículos
// (`ventavehiculos:VentaVehiculos`), que trae el NIV (VIN) y la ClaveVehicular
// como atributos estructurados dentro del <ComplementoConcepto> de la línea del
// auto. Está tanto en la factura de COMPRA (planta → agencia) como en la de
// VENTA (agencia → cliente) — es el hilo que ata ambas al mismo VIN.
//
// Respaldo débil: un VIN de 17 caracteres en la Descripción. Existe en algunas
// facturas de compra ("VIN: 3GA...") pero NO en las de venta, así que el
// complemento es la fuente necesaria, no el respaldo.
//
// Helper puro (regex sobre atributos planos), convención del repo — mismo estilo
// que src/lib/nomina/receptor-xml.ts. NO abre un parser DOM.
// ─────────────────────────────────────────────────────────────────────────────

/** Un VIN válido: 17 caracteres, alfanumérico, sin I/O/Q (estándar ISO 3779). */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function esVinValido(vin: string): boolean {
  return VIN_RE.test(vin.trim().toUpperCase());
}

function attrDe(nodo: string, name: string): string | null {
  const m = nodo.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** La línea del auto: la que trae el complemento VentaVehiculos con su NIV. */
export interface ConceptoVehiculo {
  niv: string;
  claveVehicular: string | null;
  descripcion: string | null;
  noIdentificacion: string | null;
  /** Importe de la línea SIN IVA (ValorUnitario × Cantidad, ya neto en el CFDI). */
  importe: number;
}

/** Conceptos sin complemento (seguro, traslado, accesorios…): candidatos a costo. */
export interface OtroConcepto {
  descripcion: string | null;
  claveProdServ: string | null;
  noIdentificacion: string | null;
  importe: number;
  /** VINs mencionados en el concepto (flete/seguro/preparación DE una o varias
   *  unidades) — permiten atribuir el costo, repartido entre ellas. */
  nivRefs: string[];
}

/**
 * Piso para tratar un concepto SIN complemento como la unidad misma: por debajo
 * es preparación/gestoría/accesorio aunque traiga clave de vehículo (caso real:
 * "PREPARACIÓN DE 5 UNIDADES…" con ClaveProdServ 25101500 y $900 c/u).
 */
export const UMBRAL_UNIDAD_SIN_COMPLEMENTO = 50_000;

/** Todos los VINs válidos y distintos mencionados en un texto libre. */
export function vinsDesdeTexto(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const out = new Set<string>();
  for (const m of texto.toUpperCase().matchAll(/\b([A-HJ-NPR-Z0-9]{17})\b/g)) {
    if (esVinValido(m[1])) out.add(m[1]);
  }
  return [...out];
}

export interface DatosVehiculoCfdi {
  /** Normalmente 1; el CFDI podría amparar varias unidades (una por complemento). */
  vehiculos: ConceptoVehiculo[];
  /** Demás líneas del CFDI, para mapear a VehiculoCosto en una compra. */
  otrosConceptos: OtroConcepto[];
}

/**
 * UUIDs que este CFDI SUSTITUYE (CfdiRelacionados TipoRelacion="04").
 * Una refactura válida apunta así a la factura que reemplaza — señal firme
 * para re-ligar la unidad aunque la cancelación aún no esté marcada.
 */
export function sustituyeUuidsDesdeCfdi(rawXml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w-]+:)?CfdiRelacionados\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?CfdiRelacionados>/gi;
  for (const m of rawXml.matchAll(re)) {
    if (attrDe(m[1] ?? "", "TipoRelacion") !== "04") continue;
    for (const r of (m[2] ?? "").matchAll(/<(?:[\w-]+:)?CfdiRelacionado\b([^>]*)\/?>/gi)) {
      const uuid = attrDe(r[1] ?? "", "UUID");
      if (uuid) out.push(uuid.trim().toUpperCase());
    }
  }
  return out;
}

/** CondicionesDePago del nodo Comprobante — texto libre ("CRÉDITO 30 DÍAS"). */
export function condicionesDePagoDesdeCfdi(rawXml: string): string | null {
  const el = rawXml.match(/<(?:[\w-]+:)?Comprobante\b([^>]*)>/i)?.[1];
  if (!el) return null;
  return attrDe(el, "CondicionesDePago");
}

/**
 * Días de crédito desde el texto de CondicionesDePago: "CRÉDITO 30 DÍAS" → 30,
 * "CONTADO" → 0, texto sin señal → null (no se sabe).
 */
export function diasCreditoDesdeCondiciones(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const t = texto.toUpperCase();
  const m = t.match(/(\d{1,3})\s*D[ÍI]AS?/);
  if (m) return Number(m[1]);
  if (/\bCONTADO\b|UNA\s+SOLA\s+EXHIBICI[ÓO]N/.test(t)) return 0;
  return null;
}

/** TipoDeComprobante del CFDI ("I", "E", "P", …) — null si no se encuentra. */
export function tipoComprobanteDesdeCfdi(rawXml: string): string | null {
  const el = rawXml.match(/<(?:[\w-]+:)?Comprobante\b([^>]*)>/i)?.[1];
  if (!el) return null;
  return attrDe(el, "TipoDeComprobante")?.trim().toUpperCase() ?? null;
}

/**
 * Número de motor desde el texto del concepto ("No. Motor:", "NO MOTOR", "MOTOR:").
 * El complemento VentaVehiculos no lo trae estructurado; las armadoras lo ponen
 * en la descripción junto al VIN.
 */
export function numeroMotorDesdeTexto(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = texto
    .toUpperCase()
    .match(/(?:N[OU]M?\.?\s*(?:DE\s*)?MOTOR|MOTOR)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{4,19})\b/);
  if (!m) return null;
  const valor = m[1];
  // Un VIN completo no es número de motor (la descripción suele traer ambos).
  if (valor.length === 17 && esVinValido(valor)) return null;
  return valor;
}

/**
 * Emisor del CFDI (RFC y nombre) — para resolver el proveedor canónico de una
 * compra sin cargar un parser completo (misma convención regex del repo).
 */
export function emisorDesdeCfdi(rawXml: string): { rfc: string; nombre: string | null } | null {
  const el = rawXml.match(/<(?:[\w-]+:)?Emisor\b([^>]*)\/?>/i)?.[1];
  if (!el) return null;
  const rfc = attrDe(el, "Rfc")?.trim().toUpperCase();
  if (!rfc || rfc.length < 12 || rfc.length > 13) return null;
  return { rfc, nombre: attrDe(el, "Nombre") };
}

// Matchea cada <Concepto …/> o <Concepto …>…</Concepto> (con o sin prefijo de
// namespace). Grupo 1 = atributos; grupo 3 = contenido interno (undefined si es
// self-closing). Los conceptos no anidan conceptos, así que el no-greedy es seguro.
const CONCEPTO_RE =
  /<(?:[\w-]+:)?Concepto\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w-]+:)?Concepto>)/gi;

/**
 * Extrae las unidades (por su NIV en el complemento) y los demás conceptos de un
 * CFDI. Devuelve listas vacías si el CFDI no ampara vehículos.
 */
export function extraerDatosVehiculoCfdi(rawXml: string): DatosVehiculoCfdi {
  const vehiculos: ConceptoVehiculo[] = [];
  const otrosConceptos: OtroConcepto[] = [];

  for (const m of rawXml.matchAll(CONCEPTO_RE)) {
    const attrs = m[1] ?? "";
    const inner = m[3] ?? "";
    const descripcion = attrDe(attrs, "Descripcion");
    const claveProdServ = attrDe(attrs, "ClaveProdServ");
    const noIdentificacion = attrDe(attrs, "NoIdentificacion");
    const importe = num(attrDe(attrs, "Importe")) ?? 0;
    const cantidad = num(attrDe(attrs, "Cantidad")) ?? 1;

    const venta = inner.match(/<(?:[\w-]+:)?VentaVehiculos\b[^>]*\/?>/i)?.[0];
    const nivComplemento = venta ? attrDe(venta, "Niv") : null;
    // Todos los VINs mencionados en el texto (puede haber varios: preparación
    // de N unidades en un solo concepto).
    const vinsTexto = [...new Set([...vinsDesdeTexto(descripcion), ...vinsDesdeTexto(noIdentificacion)])];

    // Un concepto ES la unidad si trae el complemento VentaVehiculos con NIV
    // válido. Sin complemento, la clave de vehículo (2510xx) NO basta — los
    // proveedores la usan también para servicios sobre vehículos. Candados
    // estructurales: cantidad 1, EXACTAMENTE un VIN en el texto y un importe
    // de unidad (≥ umbral). Todo lo demás que menciona VINs es COSTO de esas
    // unidades, repartido entre ellas.
    const vinComplementoOk =
      nivComplemento && esVinValido(nivComplemento) ? nivComplemento.trim().toUpperCase() : null;
    const esUnidad =
      vinComplementoOk != null ||
      ((claveProdServ ?? "").startsWith("2510") &&
        cantidad <= 1 &&
        vinsTexto.length === 1 &&
        importe >= UMBRAL_UNIDAD_SIN_COMPLEMENTO);

    if (esUnidad) {
      vehiculos.push({
        niv: vinComplementoOk ?? vinsTexto[0],
        claveVehicular: venta ? attrDe(venta, "ClaveVehicular") : null,
        descripcion,
        noIdentificacion,
        importe,
      });
    } else {
      otrosConceptos.push({ descripcion, claveProdServ, noIdentificacion, importe, nivRefs: vinsTexto });
    }
  }

  return { vehiculos, otrosConceptos };
}

/** Busca un VIN de 17 caracteres en texto libre (respaldo). Prefiere el que sigue a "VIN". */
export function vinDesdeDescripcion(descripcion: string): string | null {
  const txt = descripcion.toUpperCase();
  const etiquetado = txt.match(/VIN\s*[:#]?\s*([A-HJ-NPR-Z0-9]{17})\b/);
  if (etiquetado) return etiquetado[1];
  const suelto = txt.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  return suelto ? suelto[1] : null;
}

// Marcas comunes en México (para heurística de marca desde texto libre).
const MARCAS = [
  "JAC", "NISSAN", "TOYOTA", "VOLKSWAGEN", "VW", "CHEVROLET", "FORD", "KIA",
  "HYUNDAI", "MAZDA", "HONDA", "SEAT", "RENAULT", "PEUGEOT", "JEEP", "RAM",
  "DODGE", "MITSUBISHI", "SUZUKI", "BMW", "MERCEDES", "AUDI", "GMC", "CHIREY",
  "BYD", "MG", "GWM", "CHANGAN", "GEELY", "OMODA", "JETOUR", "BAIC", "FIAT",
  "ACURA", "BUICK", "CADILLAC", "LINCOLN", "MINI", "VOLVO", "SUBARU", "CUPRA",
];

/** Primera marca conocida encontrada en un texto libre (o null). */
export function marcaDesdeTexto(texto: string | null | undefined): string | null {
  const t = (texto ?? "").toUpperCase();
  return MARCAS.find((m) => new RegExp(`\\b${m}\\b`).test(t)) ?? null;
}

export interface DatosGeneralesVehiculo {
  marca: string | null;
  modelo: string | null;
  anio: number | null;
}

/**
 * Heurística de marca / modelo / año desde el texto del CFDI. El complemento no
 * los trae estructurados, así que se estiman para pre-poblar la unidad; se crea
 * con `autoCreado` para que el distribuidor confirme (precedente ActivoFijo).
 *
 * - marca: primera marca conocida encontrada en la descripción.
 * - modelo: NoIdentificacion (SKU del distribuidor, p.ej. "FRISON T9 AT 4X4"),
 *   que suele traer modelo + versión más limpio que la descripción larga.
 * - año: "Modelo:AAAA" o un año de 4 dígitos en la descripción; si no, el del CFDI.
 */
export function datosGeneralesDesdeCfdi(
  descripcion: string | null,
  noIdentificacion: string | null,
  anioFallback: number
): DatosGeneralesVehiculo {
  const d = (descripcion ?? "").toUpperCase();
  const marca = marcaDesdeTexto(d);

  const modelo = (noIdentificacion ?? "").trim().slice(0, 60) || null;

  const mModelo = d.match(/MODELO\s*[:#]?\s*((?:19|20)\d{2})/);
  const mSuelto = d.match(/\b((?:19|20)\d{2})\b/);
  const anio = mModelo ? Number(mModelo[1]) : mSuelto ? Number(mSuelto[1]) : anioFallback;

  return { marca, modelo, anio };
}

/** Mapea un concepto adicional a su tipo de VehiculoCosto por clave SAT / texto. */
export function tipoCostoDesdeConcepto(
  claveProdServ: string | null,
  descripcion: string | null
): "TRASLADO" | "ACCESORIOS" | "OTRO" {
  const d = (descripcion ?? "").toUpperCase();
  // 78101803 = servicios de traslado de vehículos; texto "TRASLADO"/"FLETE".
  if (claveProdServ === "78101803" || /\bTRASLAD|FLETE\b/.test(d)) return "TRASLADO";
  if (/\bACCESORIO|EQUIPAMIENTO|POLARIZAD|TAPET|RINES?\b/.test(d)) return "ACCESORIOS";
  return "OTRO";
}
