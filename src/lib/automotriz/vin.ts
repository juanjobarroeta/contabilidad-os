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
}

export interface DatosVehiculoCfdi {
  /** Normalmente 1; el CFDI podría amparar varias unidades (una por complemento). */
  vehiculos: ConceptoVehiculo[];
  /** Demás líneas del CFDI, para mapear a VehiculoCosto en una compra. */
  otrosConceptos: OtroConcepto[];
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

    const venta = inner.match(/<(?:[\w-]+:)?VentaVehiculos\b[^>]*\/?>/i)?.[0];
    let niv = venta ? attrDe(venta, "Niv") : null;

    // Respaldo: VIN en la descripción si no vino el complemento.
    if (!niv && descripcion) niv = vinDesdeDescripcion(descripcion);

    if (niv && esVinValido(niv)) {
      vehiculos.push({
        niv: niv.trim().toUpperCase(),
        claveVehicular: venta ? attrDe(venta, "ClaveVehicular") : null,
        descripcion,
        noIdentificacion,
        importe,
      });
    } else {
      otrosConceptos.push({ descripcion, claveProdServ, noIdentificacion, importe });
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
