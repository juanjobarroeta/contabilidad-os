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

// Corrida máxima de caracteres de clase VIN, anclada a la izquierda como \b
// (el vecino izquierdo no puede ser alfanumérico) pero SIN frontera derecha.
// Por qué: los CFDIs de seminuevos de Margom pegan el VIN a la palabra
// siguiente — «RAM 3C6LRVCG6RE119028VENTA DE VEHICULO USADO…» — y con \b…\b
// esa aparición no cierra nunca: 74 conceptos / $41.4M en 2025 extraían CERO
// VINs por esto (medido en producción, 2026-08).
const VIN_RUN_RE = /(?<![A-Z0-9_])[A-HJ-NPR-Z0-9]{17,}/g;

// Corrida más larga que 17: se acepta el prefijo de 17 SOLO si la cola es una
// palabra pegada conocida. Validado contra producción (2026-08): recupera
// 74/74 conceptos pegados con CERO falsos positivos sobre las 742 líneas de
// riesgo (NRU de CFE, peajes, cuentas prediales — corridas largas que un corte
// ciego a 17 aceptaría). La alternativa por dígito verificador (ISO 3779) se
// probó y se descartó: 316 falsos aceptes en ese mismo corpus. La cola «1»
// de un VIN con dígito de más («…TM0007571») NO está en la lista a propósito:
// cortar ahí inventaría un VIN plausible pero equivocado.
const COLA_PEGADA_RE = /^(VENTA|VEHICULO|CAMION|USADO|UNIDAD|SERIE|MOTOR)/;

/** Todos los VINs válidos y distintos mencionados en un texto libre. */
export function vinsDesdeTexto(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const out = new Set<string>();
  for (const m of texto.toUpperCase().matchAll(VIN_RUN_RE)) {
    const corrida = m[0];
    const candidato =
      corrida.length === 17
        ? corrida
        : COLA_PEGADA_RE.test(corrida.slice(17))
          ? corrida.slice(0, 17)
          : null;
    if (candidato && esVinValido(candidato)) out.add(candidato);
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

/** Cada candado que un concepto puede no pasar para contar como unidad. */
export type MotivoNoUnidad =
  | "clave_no_2510"
  | "cantidad_mayor_1"
  | "sin_vin_en_texto"
  | "varios_vins_en_texto"
  | "bajo_umbral";

export interface VeredictoUnidad {
  esUnidad: boolean;
  /** NIV elegido cuando esUnidad; null si no. */
  niv: string | null;
  /** true si entró por el complemento VentaVehiculos (ruta sin candados). */
  porComplemento: boolean;
  /**
   * TODOS los candados que falla, no sólo el primero. Contar «falla varios_vins»
   * y «falla SÓLO varios_vins» son preguntas distintas, y con el primer motivo
   * nada más no se pueden distinguir.
   */
  fallas: MotivoNoUnidad[];
}

/**
 * El veredicto de si un concepto ES la unidad. Vive aparte para que el
 * diagnóstico mida exactamente lo que decide producción: si esto se duplicara,
 * el reporte acabaría explicando un derivador que no es el que corre.
 *
 * Un concepto ES la unidad si trae el complemento VentaVehiculos con NIV
 * válido. Sin complemento, la clave de vehículo (2510xx) NO basta — los
 * proveedores la usan también para servicios sobre vehículos. Candados
 * estructurales: cantidad 1, EXACTAMENTE un VIN en el texto y un importe de
 * unidad (≥ umbral). Todo lo demás que menciona VINs es COSTO de esas unidades,
 * repartido entre ellas.
 */
export function evaluarUnidad(args: {
  claveProdServ: string | null;
  cantidad: number;
  importe: number;
  vinsTexto: string[];
  nivComplemento: string | null;
}): VeredictoUnidad {
  const { claveProdServ, cantidad, importe, vinsTexto, nivComplemento } = args;

  const vinComplementoOk =
    nivComplemento && esVinValido(nivComplemento) ? nivComplemento.trim().toUpperCase() : null;
  if (vinComplementoOk != null) {
    return { esUnidad: true, niv: vinComplementoOk, porComplemento: true, fallas: [] };
  }

  const fallas: MotivoNoUnidad[] = [];
  if (!(claveProdServ ?? "").startsWith("2510")) fallas.push("clave_no_2510");
  if (!(cantidad <= 1)) fallas.push("cantidad_mayor_1");
  if (vinsTexto.length === 0) fallas.push("sin_vin_en_texto");
  else if (vinsTexto.length > 1) fallas.push("varios_vins_en_texto");
  if (!(importe >= UMBRAL_UNIDAD_SIN_COMPLEMENTO)) fallas.push("bajo_umbral");

  return {
    esUnidad: fallas.length === 0,
    niv: fallas.length === 0 ? vinsTexto[0] : null,
    porComplemento: false,
    fallas,
  };
}

/**
 * Extrae las unidades (por su NIV en el complemento) y los demás conceptos de un
 * CFDI. Devuelve listas vacías si el CFDI no ampara vehículos.
 */
/** Un concepto del CFDI ya parseado, con el veredicto que le tocó. */
export interface ConceptoConVeredicto {
  descripcion: string | null;
  claveProdServ: string | null;
  noIdentificacion: string | null;
  importe: number;
  cantidad: number;
  claveVehicular: string | null;
  vinsTexto: string[];
  veredicto: VeredictoUnidad;
}

/**
 * Parsea los conceptos y les aplica el veredicto. Es la ÚNICA pasada: tanto la
 * derivación como el diagnóstico salen de aquí, para que el reporte no pueda
 * describir un derivador distinto del que corre.
 */
export function conceptosConVeredicto(rawXml: string): ConceptoConVeredicto[] {
  const out: ConceptoConVeredicto[] = [];

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

    out.push({
      descripcion,
      claveProdServ,
      noIdentificacion,
      importe,
      cantidad,
      claveVehicular: venta ? attrDe(venta, "ClaveVehicular") : null,
      vinsTexto,
      veredicto: evaluarUnidad({ claveProdServ, cantidad, importe, vinsTexto, nivComplemento }),
    });
  }

  return out;
}

export function extraerDatosVehiculoCfdi(rawXml: string): DatosVehiculoCfdi {
  const vehiculos: ConceptoVehiculo[] = [];
  const otrosConceptos: OtroConcepto[] = [];

  for (const c of conceptosConVeredicto(rawXml)) {
    if (c.veredicto.esUnidad) {
      vehiculos.push({
        niv: c.veredicto.niv!,
        claveVehicular: c.claveVehicular,
        descripcion: c.descripcion,
        noIdentificacion: c.noIdentificacion,
        importe: c.importe,
      });
    } else {
      otrosConceptos.push({
        descripcion: c.descripcion,
        claveProdServ: c.claveProdServ,
        noIdentificacion: c.noIdentificacion,
        importe: c.importe,
        nivRefs: c.vinsTexto,
      });
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
// GML (Giant Motors) y YUTONG venían en los CFDIs de Margom como «MARCA GML» /
// «MARCA YUTONG» y no estaban en la lista: 70+ unidades del piso quedaron
// POR REVISAR con la marca escrita en su propia descripción (medido 2026-08).
const MARCAS = [
  "JAC", "NISSAN", "TOYOTA", "VOLKSWAGEN", "VW", "CHEVROLET", "FORD", "KIA",
  "HYUNDAI", "MAZDA", "HONDA", "SEAT", "RENAULT", "PEUGEOT", "JEEP", "RAM",
  "DODGE", "MITSUBISHI", "SUZUKI", "BMW", "MERCEDES", "AUDI", "GMC", "CHIREY",
  "BYD", "MG", "GWM", "CHANGAN", "GEELY", "OMODA", "JETOUR", "BAIC", "FIAT",
  "ACURA", "BUICK", "CADILLAC", "LINCOLN", "MINI", "VOLVO", "SUBARU", "CUPRA",
  "GML", "YUTONG",
];

/** Primera marca conocida encontrada en un texto libre (o null). */
export function marcaDesdeTexto(texto: string | null | undefined): string | null {
  const t = (texto ?? "").toUpperCase();
  return MARCAS.find((m) => new RegExp(`\\b${m}\\b`).test(t)) ?? null;
}

// Dónde TERMINA la frase del modelo dentro de una descripción libre: puntuación
// o la siguiente etiqueta del machote («AÑO», «COLOR», «NUMERO DE SERIE»…).
const FIN_MODELO_RE =
  /[,;(]|\bA[ÑN]O\b|\bMODELO\b|\bMARCA\b|\bCOLOR\b|\bN[UÚ]M(?:ERO)?\b|\bNO\.?\s+MOTOR\b|\bMOTOR\b|\bSERIE\b|\bCLAVE\b|\bTIPO\b|\bVIN\b|\bNIV\b|\bCILINDROS\b|\bTRANSMISI[OÓ]N\b|\bPA[IÍ]S\b|\bDIMENSION\b|\bCAPACIDAD\b|\bVERSION\b/;

// «TIPO:» a veces trae el modelo («TIPO: SPARK NG/LT») y a veces la carrocería
// («TIPO:AUTOMOVIL») — la carrocería no nombra a la unidad.
const TIPO_GENERICO_RE =
  /^(AUTOM[OÓ]VIL|AUTO|CAMIONETA|PICK\s?-?UP|SUV|SEDAN|HATCHBACK|VAGONETA|CHASIS|CAMI[OÓ]N|AUTOB[UÚ]S|MOTOCICLETA)\b\s*$/;

const ANIO_RE = /^(?:19|20)\d{2}\b/;

/** Recorta una captura hasta el fin de frase; null si no queda nada con letras. */
function fraseModelo(captura: string): string | null {
  const corte = captura.search(FIN_MODELO_RE);
  const frase = (corte >= 0 ? captura.slice(0, corte) : captura)
    .replace(/[.:#]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return frase.length >= 2 && /[A-Z]/.test(frase) ? frase : null;
}

/**
 * Modelo desde el TEXTO del CFDI, para cuando NoIdentificacion no sirve (vacío,
 * o un código numérico como la ClaveProdServ). Los machotes reales de Margom
 * traen el modelo en lugares distintos, y en ese orden se busca:
 *
 *   1. «MODELO ZK6126BEVGS» — MODELO seguido de algo que NO es año.
 *   2. «MODELO 2021 SWIFT GLX…» — el nombre pegado después del año.
 *   3. «TIPO: SPARK NG/LT» — si no es carrocería genérica (TIPO:AUTOMOVIL).
 *   4. «VERSION CHEYENNE» — el machote de seminuevos más común.
 *   5. «RENAULT OROCH OUTSIDER TM» — lo que sigue a la marca conocida.
 *
 * Devuelve null si ningún patrón deja algo con letras: POR REVISAR es más
 * honesto que un pedazo de machote.
 */
export function modeloDesdeTexto(texto: string | null | undefined): string | null {
  const t = (texto ?? "").toUpperCase();
  if (!t) return null;

  for (const m of t.matchAll(/\bMODELO\s*[:#.]?\s*(.+)/g)) {
    const resto = m[1];
    if (!ANIO_RE.test(resto)) {
      const f = fraseModelo(resto);
      if (f) return f;
    } else {
      // El nombre puede venir DESPUÉS del año: «MODELO 2021 SWIFT GLX L4…».
      const f = fraseModelo(resto.replace(ANIO_RE, "").trim());
      if (f) return f;
    }
  }

  const tipo = t.match(/\bTIPO\s*[:#.]?\s*(.+)/);
  if (tipo) {
    const f = fraseModelo(tipo[1]);
    if (f && !TIPO_GENERICO_RE.test(f)) return f;
  }

  const version = t.match(/\bVERSION\s*[:#.]?\s*(.+)/);
  if (version) {
    const f = fraseModelo(version[1]);
    if (f) return f;
  }

  const marca = marcaDesdeTexto(t);
  if (marca) {
    const trasMarca = t.match(new RegExp(`\\b${marca}\\b[\\s.:,]*(.+)`));
    if (trasMarca) {
      const f = fraseModelo(trasMarca[1]);
      if (f) return f;
    }
  }

  return null;
}

// WMI (primeros 3 del VIN, ISO 3780) → marca. La factura de fábrica a veces no
// dice la marca en el TEXTO por ningún lado —«VEHICULO PICK UP T5 CABINA
// REGULAR…» de Giant Motors, $285K— y la clave vehicular de mitad de año aún no
// está en el Anexo 15 publicado. El VIN sí lo dice siempre. Tabla curada del
// propio padrón de Margom (2026-08): cada prefijo con ≥5 unidades cuya marca ya
// se conocía por otra vía, con el voto mayoritario (3GA = planta Giant Motors
// León: 6,688 unidades dicen JAC).
const WMI_MARCA: Record<string, string> = {
  "3GA": "JAC", // Giant Motors León (JAC ensamblado en México)
  LJ1: "JAC", // JAC Anhui (importados)
  "3GE": "GML",
  LZY: "YUTONG",
  "3N1": "NISSAN", "3N6": "NISSAN", "3N8": "NISSAN",
  JS2: "SUZUKI", TSM: "SUZUKI", MHY: "SUZUKI", MBH: "SUZUKI",
  "1C6": "RAM", "3C6": "RAM",
  "3KP": "KIA", MZB: "KIA",
  "93Y": "RENAULT",
  LSG: "CHEVROLET", KL8: "CHEVROLET",
  MB2: "HYUNDAI",
  "9BW": "VOLKSWAGEN", MEX: "VOLKSWAGEN", "3VW": "VOLKSWAGEN",
  LSJ: "MG",
  "9BD": "FIAT",
  VSS: "SEAT",
};

/** Marca desde el WMI del VIN (fallback cuando ni el texto ni el catálogo la dan). */
export function marcaDesdeVin(vin: string | null | undefined): string | null {
  const v = (vin ?? "").trim().toUpperCase();
  if (!esVinValido(v)) return null;
  return WMI_MARCA[v.slice(0, 3)] ?? null;
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
 *   Un SKU puramente numérico NO es un modelo (los autobuses Yutong traían la
 *   ClaveProdServ ahí: modelo «25101502») y los seminuevos de particulares no
 *   traen SKU: en ambos casos se lee la descripción (modeloDesdeTexto).
 * - año: "Modelo:AAAA" o un año de 4 dígitos en la descripción; si no, el del CFDI.
 */
export function datosGeneralesDesdeCfdi(
  descripcion: string | null,
  noIdentificacion: string | null,
  anioFallback: number
): DatosGeneralesVehiculo {
  const d = (descripcion ?? "").toUpperCase();
  const marca = marcaDesdeTexto(d);

  const sku = (noIdentificacion ?? "").trim().slice(0, 60);
  const modelo = (sku && !/^\d{4,}$/.test(sku) ? sku : null) ?? modeloDesdeTexto(d);

  const mModelo = d.match(/MODELO\s*[:#]?\s*((?:19|20)\d{2})/);
  const mSuelto = d.match(/\b((?:19|20)\d{2})\b/);
  const anio = mModelo ? Number(mModelo[1]) : mSuelto ? Number(mSuelto[1]) : anioFallback;

  return { marca, modelo, anio };
}

/** Mapea un concepto adicional a su tipo de VehiculoCosto por clave SAT / texto. */
export function tipoCostoDesdeConcepto(
  claveProdServ: string | null,
  descripcion: string | null
): "TRASLADO" | "ACCESORIOS" | "ACONDICIONAMIENTO" | "OTRO" {
  const d = (descripcion ?? "").toUpperCase();
  // 78101803 = servicios de traslado de vehículos; texto "TRASLADO"/"FLETE".
  if (claveProdServ === "78101803" || /\bTRASLAD|FLETE\b/.test(d)) return "TRASLADO";
  // La conversión va ANTES que accesorios: «CONVERSIÓN … CON EQUIPAMIENTO
  // MÉDICO» es una carrocería completa, no un juego de tapetes.
  if (esConversionDeCarroceria(d)) return "ACONDICIONAMIENTO";
  if (/\bACCESORIO|EQUIPAMIENTO|POLARIZAD|TAPET|RINES?\b/.test(d)) return "ACCESORIOS";
  return "OTRO";
}

/**
 * ¿El texto describe una CONVERSIÓN de carrocería sobre una unidad, en vez de
 * la compra de una unidad?
 *
 * El negocio: la agencia compra el chasis, le paga a un tercero la conversión
 * (ambulancia, patrulla, unidad médica, blindaje) y vende la unidad convertida
 * —típicamente a gobierno—. Esa factura del carrocero llega con clave 2510xx y
 * el VIN del chasis, así que parece una segunda compra de la MISMA unidad: sin
 * este candado el derivador la archivaba como DUPLICADA y su costo terminaba en
 * «Otros gastos» ($17.5M en Margom, 6 conceptos, medido 2026-08).
 *
 * Sólo aplica cuando la unidad YA es nuestra (ver el llamador): comprar una
 * unidad que ya venía convertida SÍ es una compra, y ese caso —6 conceptos,
 * $2.3M— no debe tocarse.
 */
export function esConversionDeCarroceria(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const d = texto.toUpperCase();
  // «AUTO USADO» manda: una recompra de seminueva no es una conversión, aunque
  // el texto mencione el equipamiento que trae.
  if (/AUTO USADO|VEH[IÍ]CULO USADO/.test(d)) return false;
  return /CONVERSI[OÓ]N|BLINDAJ|BLINDAD|AMBULANCI|CARROCER[IÍ]A|PATRULL|ADAPTACI[OÓ]N|TRANSFORMACI[OÓ]N/.test(d);
}
