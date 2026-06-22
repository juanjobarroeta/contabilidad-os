// ─────────────────────────────────────────────────────────────────────────────
// Representación impresa del CFDI — parser del XML almacenado (rawXml) a un DTO
// tipado por tipo de comprobante (Ingreso/Egreso · Nómina · Pago/REP · Traslado).
//
// El SAT no obliga a guardar un PDF: la representación impresa se genera del XML.
// La mayoría de nuestros CFDIs vienen de Descarga Masiva (sin PDF del PAC), así
// que esta es la única forma de verlos legibles. Parser regex namespace-agnóstico
// (igual estilo que sat-fiel.ts) — sin dependencias de XML, resiliente a prefijos
// (cfdi:/nomina12:/pago20:) y a atributos faltantes.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v: string | null | undefined): number | null =>
  v != null && v !== "" && !isNaN(parseFloat(v)) ? parseFloat(v) : null;

/** Atributos de la primera etiqueta `<(ns:)?tag ...>` encontrada. */
function tagAttrs(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b([^>]*)`).exec(xml);
  return m ? m[1] : null;
}

/** Cuerpo (inner) de la primera etiqueta `<(ns:)?tag ...>...</tag>`. */
function tagBody(xml: string, tag: string): string | null {
  const m = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`
  ).exec(xml);
  return m ? m[1] : null;
}

/** Todas las etiquetas `<(ns:)?tag ...>` (self-closing o con cuerpo). Devuelve attrs+body. */
function allTags(xml: string, tag: string): Array<{ attrs: string; body: string }> {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>)`,
    "g"
  );
  const out: Array<{ attrs: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

const A = (attrs: string | null, name: string): string | null =>
  attrs ? new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null : null;

export interface RepTraslado {
  impuesto: string; // ISR | IVA | IEPS
  tipoFactor: string; // Tasa | Cuota | Exento
  tasaOCuota: number | null;
  base: number | null;
  importe: number;
  retencion: boolean;
}
export interface RepConcepto {
  claveProdServ: string;
  noIdentificacion: string | null;
  cantidad: number;
  claveUnidad: string;
  unidad: string | null;
  descripcion: string;
  valorUnitario: number;
  importe: number;
  descuento: number;
  objetoImp: string | null;
}
export interface RepNominaConcepto {
  tipo: string | null;
  clave: string | null;
  concepto: string | null;
  gravado: number | null;
  exento: number | null;
  importe: number | null;
}
export interface RepNomina {
  tipoNomina: string | null;
  fechaPago: string | null;
  fechaInicialPago: string | null;
  fechaFinalPago: string | null;
  numDiasPagados: number | null;
  totalPercepciones: number | null;
  totalDeducciones: number | null;
  totalOtrosPagos: number | null;
  registroPatronal: string | null;
  curp: string | null;
  nss: string | null;
  fechaInicioRelLaboral: string | null;
  antiguedad: string | null;
  tipoContrato: string | null;
  tipoRegimen: string | null;
  numEmpleado: string | null;
  departamento: string | null;
  puesto: string | null;
  riesgoPuesto: string | null;
  periodicidadPago: string | null;
  salarioBaseCotApor: number | null;
  salarioDiarioIntegrado: number | null;
  percepciones: RepNominaConcepto[];
  deducciones: RepNominaConcepto[];
  otrosPagos: RepNominaConcepto[];
}
export interface RepPagoDocto {
  idDocumento: string | null;
  serie: string | null;
  folio: string | null;
  monedaDR: string | null;
  numParcialidad: string | null;
  impSaldoAnt: number | null;
  impPagado: number | null;
  impSaldoInsoluto: number | null;
}
export interface RepPago {
  fechaPago: string | null;
  formaDePagoP: string | null;
  monedaP: string | null;
  tipoCambioP: number | null;
  monto: number | null;
  doctos: RepPagoDocto[];
}
export interface Representacion {
  version: string | null;
  tipoComprobante: string | null; // I | E | T | N | P
  serie: string | null;
  folio: string | null;
  fecha: string | null;
  lugarExpedicion: string | null;
  formaPago: string | null;
  metodoPago: string | null;
  condicionesDePago: string | null;
  moneda: string | null;
  tipoCambio: number | null;
  subtotal: number | null;
  descuento: number | null;
  total: number | null;
  totalImpuestosTrasladados: number | null;
  totalImpuestosRetenidos: number | null;
  noCertificadoEmisor: string | null;
  emisor: { rfc: string | null; nombre: string | null; regimenFiscal: string | null };
  receptor: {
    rfc: string | null;
    nombre: string | null;
    domicilioFiscal: string | null;
    regimenFiscal: string | null;
    usoCfdi: string | null;
  };
  conceptos: RepConcepto[];
  traslados: RepTraslado[];
  retenciones: RepTraslado[];
  tfd: {
    uuid: string | null;
    fechaTimbrado: string | null;
    rfcProvCertif: string | null;
    selloCFD: string | null;
    noCertificadoSAT: string | null;
    selloSAT: string | null;
    version: string | null;
  } | null;
  cadenaOriginalTFD: string | null;
  verificacionUrl: string | null;
  nomina: RepNomina | null;
  pagos: RepPago[] | null;
}

const IMP: Record<string, string> = { "001": "ISR", "002": "IVA", "003": "IEPS" };
const FACTOR: Record<string, string> = { tasa: "Tasa", cuota: "Cuota", exento: "Exento" };

function parseImpuestos(xml: string): { traslados: RepTraslado[]; retenciones: RepTraslado[] } {
  const traslados: RepTraslado[] = [];
  const retenciones: RepTraslado[] = [];
  // Sólo el nodo <Impuestos> a nivel comprobante (después de </Conceptos>).
  const conceptosEnd = xml.search(/<\/(?:[a-zA-Z0-9]+:)?Conceptos>/);
  if (conceptosEnd === -1) return { traslados, retenciones };
  const tail = xml.slice(conceptosEnd);
  const block = /<(?:[a-zA-Z0-9]+:)?Impuestos\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?Impuestos>/.exec(tail)?.[1];
  if (block == null) return { traslados, retenciones };
  const re = /<(?:[a-zA-Z0-9]+:)?(Traslado|Retencion)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[2];
    const tipo = IMP[A(attrs, "Impuesto") ?? ""];
    if (!tipo) continue;
    const row: RepTraslado = {
      impuesto: tipo,
      tipoFactor: FACTOR[(A(attrs, "TipoFactor") ?? "Tasa").toLowerCase()] ?? "Tasa",
      tasaOCuota: num(A(attrs, "TasaOCuota")),
      base: num(A(attrs, "Base")),
      importe: num(A(attrs, "Importe")) ?? 0,
      retencion: m[1] === "Retencion",
    };
    (row.retencion ? retenciones : traslados).push(row);
  }
  return { traslados, retenciones };
}

function parseNomina(xml: string): RepNomina | null {
  const nomAttrs = tagAttrs(xml, "Nomina");
  if (nomAttrs == null) return null;
  const recAttrs = tagAttrs(xml, "Receptor"); // dentro del complemento; el primero es del CFDI
  // El Receptor de nómina es el SEGUNDO Receptor del XML (el primero es el del CFDI).
  // Buscamos el Receptor que viva dentro del bloque <Nomina>.
  const nominaBlock = tagBody(xml, "Nomina") ?? "";
  const nomRecAttrs = tagAttrs(nominaBlock, "Receptor") ?? recAttrs;
  const nomEmiAttrs = tagAttrs(nominaBlock, "Emisor");

  const percepciones: RepNominaConcepto[] = allTags(xml, "Percepcion").map((p) => ({
    tipo: A(p.attrs, "TipoPercepcion"),
    clave: A(p.attrs, "Clave"),
    concepto: A(p.attrs, "Concepto"),
    gravado: num(A(p.attrs, "ImporteGravado")),
    exento: num(A(p.attrs, "ImporteExento")),
    importe: (num(A(p.attrs, "ImporteGravado")) ?? 0) + (num(A(p.attrs, "ImporteExento")) ?? 0),
  }));
  const deducciones: RepNominaConcepto[] = allTags(xml, "Deduccion").map((d) => ({
    tipo: A(d.attrs, "TipoDeduccion"),
    clave: A(d.attrs, "Clave"),
    concepto: A(d.attrs, "Concepto"),
    gravado: null,
    exento: null,
    importe: num(A(d.attrs, "Importe")),
  }));
  const otrosPagos: RepNominaConcepto[] = allTags(xml, "OtroPago").map((o) => ({
    tipo: A(o.attrs, "TipoOtroPago"),
    clave: A(o.attrs, "Clave"),
    concepto: A(o.attrs, "Concepto"),
    gravado: null,
    exento: null,
    importe: num(A(o.attrs, "Importe")),
  }));

  return {
    tipoNomina: A(nomAttrs, "TipoNomina"),
    fechaPago: A(nomAttrs, "FechaPago"),
    fechaInicialPago: A(nomAttrs, "FechaInicialPago"),
    fechaFinalPago: A(nomAttrs, "FechaFinalPago"),
    numDiasPagados: num(A(nomAttrs, "NumDiasPagados")),
    totalPercepciones: num(A(nomAttrs, "TotalPercepciones")),
    totalDeducciones: num(A(nomAttrs, "TotalDeducciones")),
    totalOtrosPagos: num(A(nomAttrs, "TotalOtrosPagos")),
    registroPatronal: A(nomEmiAttrs, "RegistroPatronal"),
    curp: A(nomRecAttrs, "Curp"),
    nss: A(nomRecAttrs, "NumSeguridadSocial"),
    fechaInicioRelLaboral: A(nomRecAttrs, "FechaInicioRelLaboral"),
    antiguedad: A(nomRecAttrs, "Antigüedad") ?? A(nomRecAttrs, "Antiguedad"),
    tipoContrato: A(nomRecAttrs, "TipoContrato"),
    tipoRegimen: A(nomRecAttrs, "TipoRegimen"),
    numEmpleado: A(nomRecAttrs, "NumEmpleado"),
    departamento: A(nomRecAttrs, "Departamento"),
    puesto: A(nomRecAttrs, "Puesto"),
    riesgoPuesto: A(nomRecAttrs, "RiesgoPuesto"),
    periodicidadPago: A(nomRecAttrs, "PeriodicidadPago"),
    salarioBaseCotApor: num(A(nomRecAttrs, "SalarioBaseCotApor")),
    salarioDiarioIntegrado: num(A(nomRecAttrs, "SalarioDiarioIntegrado")),
    percepciones,
    deducciones,
    otrosPagos,
  };
}

function parsePagos(xml: string): RepPago[] | null {
  const pagos = allTags(xml, "Pago");
  if (pagos.length === 0) return null;
  return pagos.map((p) => ({
    fechaPago: A(p.attrs, "FechaPago"),
    formaDePagoP: A(p.attrs, "FormaDePagoP"),
    monedaP: A(p.attrs, "MonedaP"),
    tipoCambioP: num(A(p.attrs, "TipoCambioP")),
    monto: num(A(p.attrs, "Monto")),
    doctos: allTags(p.body, "DoctoRelacionado").map((d) => ({
      idDocumento: A(d.attrs, "IdDocumento")?.toUpperCase() ?? null,
      serie: A(d.attrs, "Serie"),
      folio: A(d.attrs, "Folio"),
      monedaDR: A(d.attrs, "MonedaDR"),
      numParcialidad: A(d.attrs, "NumParcialidad"),
      impSaldoAnt: num(A(d.attrs, "ImpSaldoAnt")),
      impPagado: num(A(d.attrs, "ImpPagado")),
      impSaldoInsoluto: num(A(d.attrs, "ImpSaldoInsoluto")),
    })),
  }));
}

/** URL de verificación del SAT (lo que codifica el QR de la representación impresa). */
function verificacionUrl(uuid: string | null, reEmisor: string | null, rrReceptor: string | null, total: number | null, selloCFD: string | null): string | null {
  if (!uuid || !reEmisor) return null;
  const tt = (total ?? 0).toFixed(6).padStart(17, "0"); // 10 enteros + . + 6 decimales
  const fe = selloCFD ? selloCFD.slice(-8) : "";
  const qs = new URLSearchParams({ id: uuid, re: reEmisor, rr: rrReceptor ?? "", tt, fe });
  return `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?${qs.toString()}`;
}

export function parseRepresentacion(xml: string): Representacion {
  const root = tagAttrs(xml, "Comprobante");
  const emi = tagAttrs(xml, "Emisor");
  // El primer Receptor del XML es el del CFDI (el de nómina vive dentro de <Nomina>).
  const rec = tagAttrs(xml, "Receptor");
  const { traslados, retenciones } = parseImpuestos(xml);

  const conceptos: RepConcepto[] = allTags(xml, "Concepto")
    .filter((c) => A(c.attrs, "ClaveProdServ"))
    .map((c) => ({
      claveProdServ: A(c.attrs, "ClaveProdServ") ?? "",
      noIdentificacion: A(c.attrs, "NoIdentificacion"),
      cantidad: num(A(c.attrs, "Cantidad")) ?? 1,
      claveUnidad: A(c.attrs, "ClaveUnidad") ?? "E48",
      unidad: A(c.attrs, "Unidad"),
      descripcion: A(c.attrs, "Descripcion") ?? "",
      valorUnitario: num(A(c.attrs, "ValorUnitario")) ?? 0,
      importe: num(A(c.attrs, "Importe")) ?? 0,
      descuento: num(A(c.attrs, "Descuento")) ?? 0,
      objetoImp: A(c.attrs, "ObjetoImp"),
    }));

  // TimbreFiscalDigital
  const tfdAttrs = tagAttrs(xml, "TimbreFiscalDigital");
  const selloCFD = tfdAttrs ? A(tfdAttrs, "SelloCFD") : A(root, "Sello");
  const tfd = tfdAttrs
    ? {
        uuid: A(tfdAttrs, "UUID")?.toUpperCase() ?? null,
        fechaTimbrado: A(tfdAttrs, "FechaTimbrado"),
        rfcProvCertif: A(tfdAttrs, "RfcProvCertif"),
        selloCFD,
        noCertificadoSAT: A(tfdAttrs, "NoCertificadoSAT"),
        selloSAT: A(tfdAttrs, "SelloSAT"),
        version: A(tfdAttrs, "Version"),
      }
    : null;

  const cadenaOriginalTFD = tfd
    ? `||${tfd.version ?? ""}|${tfd.uuid ?? ""}|${tfd.fechaTimbrado ?? ""}|${tfd.rfcProvCertif ?? ""}|${tfd.selloCFD ?? ""}|${tfd.noCertificadoSAT ?? ""}||`
    : null;

  const tipoComprobante = A(root, "TipoDeComprobante");
  const rfcEmisor = A(emi, "Rfc");
  const rfcReceptor = A(rec, "Rfc");
  const total = num(A(root, "Total"));

  return {
    version: A(root, "Version"),
    tipoComprobante,
    serie: A(root, "Serie"),
    folio: A(root, "Folio"),
    fecha: A(root, "Fecha"),
    lugarExpedicion: A(root, "LugarExpedicion"),
    formaPago: A(root, "FormaPago"),
    metodoPago: A(root, "MetodoPago"),
    condicionesDePago: A(root, "CondicionesDePago"),
    moneda: A(root, "Moneda"),
    tipoCambio: num(A(root, "TipoCambio")),
    subtotal: num(A(root, "SubTotal")),
    descuento: num(A(root, "Descuento")),
    total,
    totalImpuestosTrasladados: num(A(root, "TotalImpuestosTrasladados")),
    totalImpuestosRetenidos: num(A(root, "TotalImpuestosRetenidos")),
    noCertificadoEmisor: A(root, "NoCertificado"),
    emisor: {
      rfc: rfcEmisor,
      nombre: A(emi, "Nombre"),
      regimenFiscal: A(emi, "RegimenFiscal"),
    },
    receptor: {
      rfc: rfcReceptor,
      nombre: A(rec, "Nombre"),
      domicilioFiscal: A(rec, "DomicilioFiscalReceptor"),
      regimenFiscal: A(rec, "RegimenFiscalReceptor"),
      usoCfdi: A(rec, "UsoCFDI"),
    },
    conceptos,
    traslados,
    retenciones,
    tfd,
    cadenaOriginalTFD,
    verificacionUrl: verificacionUrl(tfd?.uuid ?? null, rfcEmisor, rfcReceptor, total, selloCFD),
    nomina: tipoComprobante === "N" ? parseNomina(xml) : null,
    pagos: tipoComprobante === "P" ? parsePagos(xml) : null,
  };
}
