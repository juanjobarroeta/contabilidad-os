import { Fiel } from "@nodecfdi/sat-ws-descarga-masiva";
import { Certificate, Credential } from "@nodecfdi/credentials/node";
import { prisma } from "./prisma";
import { abrirCredencial, descifrarCerParaVigencia } from "./vault";
import { cuentasPredialesDeConcepto } from "@/lib/facturas/predial";

export async function getFielForCompany(companyId: string, actor = "cron:sat"): Promise<Fiel> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { fielCer: true, fielKey: true, fielPassword: true, rfc: true },
  });

  if (!company?.fielCer || !company?.fielKey || !company?.fielPassword) {
    throw new Error(
      "FIEL (e.firma) no configurada. Sube los archivos .cer y .key en el onboarding de tu empresa."
    );
  }

  // Cifrada en reposo — el descifrado pasa por la bóveda, que deja bitácora
  // del uso (legacy en claro sigue pasando, igual que antes).
  const abierta = abrirCredencial({
    companyId,
    tipo: "fiel",
    proposito: "sat-descarga",
    actor,
    valores: { cer: company.fielCer, key: company.fielKey, password: company.fielPassword },
  });
  const cerBuffer = Buffer.from(abierta.cer, "base64");
  const keyBuffer = Buffer.from(abierta.key, "base64");

  const fiel = Fiel.create(
    cerBuffer.toString("binary"),
    keyBuffer.toString("binary"),
    abierta.password
  );

  if (!fiel.isValid()) {
    throw new Error(
      `FIEL inválida o expirada para RFC ${company.rfc}. Verifica que los archivos .cer y .key sean correctos y que la contraseña sea la correcta.`
    );
  }

  return fiel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vigencia de la e.firma. Una FIEL vencida rompe la descarga masiva EN SILENCIO
// (Fiel.isValid() → false y el cron sólo acumula el error), así que exponemos
// las fechas del certificado para poder avisar ANTES y explicar DESPUÉS.
// ─────────────────────────────────────────────────────────────────────────────

export interface FielVigencia {
  /** ¿El certificado está vigente HOY? (false también si no se pudo parsear) */
  valida: boolean;
  validoDesde?: Date;
  validoHasta?: Date;
  rfc?: string;
}

/**
 * Vigencia de un certificado .cer (PEM, DER o DER base64 — el formato en que se
 * almacena tras descifrar). PURA y sin excepciones: cualquier error de parseo
 * devuelve `{ valida: false }`.
 */
export function parseFielVigencia(cerContents: string): FielVigencia {
  try {
    const cert = new Certificate(cerContents);
    return {
      valida: cert.validOn(),
      validoDesde: cert.validFrom(),
      validoHasta: cert.validTo(),
      rfc: cert.rfc() || undefined,
    };
  } catch {
    return { valida: false };
  }
}

/**
 * Vigencia de la FIEL almacenada de una empresa. Nunca lanza: `null` si la
 * empresa no existe o no tiene .cer; `{ valida: false }` si no se pudo parsear
 * (cifrado corrupto, clave de cifrado ausente, certificado ilegible).
 */
export async function getFielVigenciaForCompany(companyId: string): Promise<FielVigencia | null> {
  try {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { fielCer: true },
    });
    if (!company?.fielCer) return null;
    return parseFielVigencia(descifrarCerParaVigencia(company.fielCer));
  } catch {
    return { valida: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de credenciales SAT AL SUBIRLAS (sin tocar al SAT).
//
// Caso real: una cliente subió su CSD (sello) en el lugar de la e.firma. El
// badge de vigencia se veía verde ("Vigente hasta 2027" — la fecha del .cer es
// válida para ambos tipos) pero la descarga masiva fallaba con el genérico
// "FIEL inválida o expirada" (Fiel.isValid() rechaza certificados de sello).
// Dos mensajes en conflicto y cero pistas. Aquí se valida TODO al guardar:
// tipo correcto (e.firma vs sello), vigencia, RFC del certificado, que la
// llave corresponda al certificado y que la contraseña abra la llave.
// ─────────────────────────────────────────────────────────────────────────────

export type ValidacionCredencial =
  | { ok: true; validoHasta: Date | null }
  | { ok: false; error: string };

export function validarCredencialSat(args: {
  cerBase64: string;
  keyBase64: string;
  password: string;
  rfcEsperado?: string;
  esperado: "FIEL" | "CSD";
}): ValidacionCredencial {
  const nombre = args.esperado === "FIEL" ? "e.firma" : "CSD (sello)";

  let cert: Certificate;
  try {
    cert = new Certificate(Buffer.from(args.cerBase64, "base64").toString("binary"));
  } catch {
    return { ok: false, error: "El archivo .cer no se pudo leer como certificado del SAT. Revisa que sea el .cer correcto." };
  }

  const tipo = cert.satType();
  if (args.esperado === "FIEL" && tipo.isCsd()) {
    return {
      ok: false,
      error:
        "Estos archivos son del CSD (el sello para facturar), no de la e.firma. La e.firma es la que usas para entrar al portal del SAT — sube ese otro par de .cer/.key.",
    };
  }
  if (args.esperado === "CSD" && tipo.isFiel()) {
    return {
      ok: false,
      error:
        "Estos archivos son de la e.firma, no del CSD (sello). Para timbrar facturas se usa el CSD que se genera en el portal del SAT.",
    };
  }

  if (!cert.validOn()) {
    const hasta = cert.validTo();
    return {
      ok: false,
      error: `El certificado de ${nombre} está vencido${hasta ? ` (venció el ${hasta.toISOString().slice(0, 10)})` : ""}. Renuévalo en el SAT y sube los archivos nuevos.`,
    };
  }

  if (args.rfcEsperado) {
    const rfcCert = (cert.rfc() || "").trim().toUpperCase();
    if (rfcCert && rfcCert !== args.rfcEsperado.trim().toUpperCase()) {
      return { ok: false, error: `El certificado pertenece al RFC ${rfcCert}, no al RFC de esta empresa (${args.rfcEsperado}).` };
    }
  }

  try {
    Credential.create(
      Buffer.from(args.cerBase64, "base64").toString("binary"),
      Buffer.from(args.keyBase64, "base64").toString("binary"),
      args.password,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message.toLowerCase() : "";
    if (msg.includes("belong")) {
      return { ok: false, error: `La llave .key no corresponde al certificado .cer — parece que se mezclaron archivos de ${nombre} distintos.` };
    }
    return { ok: false, error: `La contraseña no abre la llave privada (.key) de tu ${nombre}. Revisa mayúsculas, minúsculas y espacios.` };
  }

  return { ok: true, validoHasta: cert.validTo() ?? null };
}

/**
 * Mapa de `tipoDeComprobante` de CFDI 3.2 a la letra de 3.3/4.0.
 *
 * 3.2 usaba PALABRAS y sólo tenía tres: no existían "P" (complemento de pago,
 * llegó con 3.3) ni "N" (la nómina de 3.2 era un complemento sobre "egreso").
 */
const TIPO_32: Record<string, "I" | "E" | "T"> = {
  ingreso: "I",
  egreso: "E",
  traslado: "T",
};

/**
 * Clave del catálogo ClaveProdServ para «No existe en el catálogo».
 *
 * CFDI 3.2 es ANTERIOR al catálogo (llegó con 3.3), así que sus conceptos no
 * traen clave y no hay ninguna que sea la correcta. Ponerle ésta es decir la
 * verdad: no hay clave. Inventar una plausible —25101500 -«vehículos»— sería
 * fabricar un dato fiscal, y de ahí cuelgan el inventario automotriz y la
 * clasificación de gastos.
 */
const CLAVE_PROD_SERV_SIN_CATALOGO = "01010101";

/** Parse key fields from a CFDI XML string */
export function parseCfdiXml(xml: string) {
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(xml)?.[1] ?? null;
  /** Primer nombre que exista, para atributos que cambiaron de caja entre 3.2 y 3.3. */
  const attrAny = (...names: string[]) => {
    for (const n of names) {
      const v = attr(n);
      if (v != null) return v;
    }
    return null;
  };
  const attrIn = (tag: string, ...names: string[]) => {
    const tagMatch = new RegExp(`<[^>]*:${tag}[^>]+>`).exec(xml);
    if (!tagMatch) return null;
    for (const n of names) {
      const v = new RegExp(`\\b${n}="([^"]+)"`).exec(tagMatch[0])?.[1];
      if (v != null) return v;
    }
    return null;
  };

  // ── ¿Qué versión de CFDI es esto? ─────────────────────────────────────────
  // Se lee del nodo raíz y no de todo el XML: el Timbre Fiscal Digital trae su
  // PROPIA `Version`/`version`, y buscar suelto agarraría la del timbre.
  //
  // 3.2 (vigente hasta el 2017-11-30) escribe los atributos en minúscula
  // —`fecha`, `total`, `subTotal`, `rfc`— y `tipoDeComprobante` con palabras.
  // Sin esto, un 3.2 se parsea a NADA: `fecha` sale null, el importador lo da
  // por inválido y el comprobante desaparece sin ruido.
  const rootAttrs = /<(?:[a-zA-Z0-9]+:)?Comprobante\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const rootAttr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(rootAttrs)?.[1] ?? null;
  const version = rootAttr("Version") ?? rootAttr("version");
  const es32 = version != null && version.startsWith("3.2");

  // UUID from TimbreFiscalDigital. Normalizamos a MAYÚSCULAS: el folio fiscal
  // es case-insensitive, pero distintas fuentes (PAC vs descarga SAT) lo traen
  // con distinta caja. Si no canonizamos, el mismo CFDI se duplica y las
  // cancelaciones no empatan. La forma canónica del SAT es mayúsculas.
  // (El TFD 1.0 de 3.2 también lo trae en mayúsculas, así que no cambia.)
  const uuid = attr("UUID")?.toUpperCase() ?? null;
  const fecha = rootAttr("Fecha") ?? rootAttr("fecha");
  const tipoCrudo = rootAttr("TipoDeComprobante") ?? rootAttr("tipoDeComprobante");
  const subtotal = parseFloat(rootAttr("SubTotal") ?? rootAttr("subTotal") ?? "0");
  const total = parseFloat(rootAttr("Total") ?? rootAttr("total") ?? "0");
  // 3.2 traía `formaDePago`/`metodoDePago` como TEXTO LIBRE («PAGO EN UNA SOLA
  // EXHIBICION»), no como clave del catálogo. Un texto ahí rompería cualquier
  // regla que compare contra las claves, así que se deja el default de «por
  // definir» — que es exactamente lo que sabemos.
  const formaPago = (es32 ? null : attr("FormaPago")) ?? "99";
  const metodoPago = (es32 ? null : attr("MetodoPago")) ?? "PUE";
  // UsoCFDI no existe en 3.2.
  const usoCfdi = attrIn("Receptor", "UsoCFDI") ?? "G03";
  const moneda = rootAttr("Moneda") ?? rootAttr("moneda") ?? "MXN";
  const numOf = (v: string | null) => (v != null && v !== "" ? parseFloat(v) : null);

  // La nómina de 3.2 viajaba como COMPLEMENTO sobre un "egreso": no había tipo
  // "N". Si se deja como E, el recibo entra como gasto y `importarNominaHistorica`
  // nunca lo ve. Se reconoce por la presencia del complemento.
  const traeComplementoNomina = /<(?:[a-zA-Z0-9]+:)?Nomina\b/.test(xml);
  const tipo = es32
    ? traeComplementoNomina
      ? "N"
      : (TIPO_32[(tipoCrudo ?? "").toLowerCase()] ?? null)
    : tipoCrudo; // I, E, T, N, P

  // ── Desglose de impuestos a nivel comprobante ──────────────────────────────
  // The invoice-level <cfdi:Impuestos> node — the one AFTER </cfdi:Conceptos> —
  // carries the authoritative totals per impuesto/factor/tasa, including
  // TipoFactor="Exento" rows whose Base is the valor de actos exentos that the
  // IVA proporción de acreditamiento (Art. 5 LIVA) needs. Concepto-level
  // Traslado/Retencion nodes are excluded by scoping to the tail after the
  // Conceptos block. The (Traslado|Retencion)\b boundary skips the plural
  // container tags and the complemento-de-pago TrasladoDR/TrasladoP variants.
  // 3.3/4.0 identifican el impuesto por CLAVE ("002"); 3.2 lo hacía por NOMBRE
  // ("IVA"). Se aceptan ambos para que el desglose de un 3.2 no salga vacío.
  const IMPUESTO_MAP: Record<string, "ISR" | "IVA" | "IEPS"> = {
    "001": "ISR",
    "002": "IVA",
    "003": "IEPS",
    ISR: "ISR",
    IVA: "IVA",
    IEPS: "IEPS",
  };
  const FACTOR_MAP: Record<string, "TASA" | "CUOTA" | "EXENTO"> = { tasa: "TASA", cuota: "CUOTA", exento: "EXENTO" };
  const taxes: Array<{
    tipo: "ISR" | "IVA" | "IEPS";
    factor: "TASA" | "CUOTA" | "EXENTO";
    tasa: number;
    base: number | null;
    importe: number;
    retencion: boolean;
  }> = [];
  let impuestosNode = false;
  const conceptosEnd = xml.search(/<\/(?:[a-zA-Z0-9]+:)?Conceptos>/);
  if (conceptosEnd !== -1) {
    const tail = xml.slice(conceptosEnd);
    const impuestosBlock =
      /<(?:[a-zA-Z0-9]+:)?Impuestos\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?Impuestos>/.exec(tail)?.[1];
    if (impuestosBlock != null) {
      impuestosNode = true;
      const nodeRe = /<(?:[a-zA-Z0-9]+:)?(Traslado|Retencion)\b([^>]*?)\/?>/g;
      let txm: RegExpExecArray | null;
      while ((txm = nodeRe.exec(impuestosBlock)) !== null) {
        const attrs = txm[2];
        const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
        // 3.2 escribe `impuesto`/`importe`/`tasa` en minúscula.
        const tipoImp = IMPUESTO_MAP[(get("Impuesto") ?? get("impuesto") ?? "").toUpperCase()];
        if (!tipoImp) continue;
        taxes.push({
          tipo: tipoImp,
          // Retenciones a nivel comprobante no traen TipoFactor/TasaOCuota.
          // 3.2 tampoco: no existía el concepto de TipoFactor.
          factor: FACTOR_MAP[(get("TipoFactor") ?? "Tasa").toLowerCase()] ?? "TASA",
          // En 3.2 la tasa venía en PORCENTAJE ("16.00"); en 3.3/4.0 en tanto
          // por uno ("0.160000"). Se normaliza a tanto por uno.
          tasa: (() => {
            const t = numOf(get("TasaOCuota") ?? get("tasa"));
            if (t == null) return 0;
            return es32 && t > 1 ? t / 100 : t;
          })(),
          // 3.2 no tenía Base a nivel impuesto.
          base: numOf(get("Base")),
          importe: numOf(get("Importe") ?? get("importe")) ?? 0,
          retencion: txm[1] === "Retencion",
        });
      }
    }
  }

  // IVA trasladado total. Prefer the parsed IVA-only sum: the legacy
  // TotalImpuestosTrasladados attr includes IEPS, and the total−subtotal
  // fallback is wrong when there are retenciones.
  const ivaMatch = /\b[Tt]otalImpuestosTrasladados="([^"]+)"/.exec(xml);
  const ivaTotal = impuestosNode
    ? taxes.filter((t) => t.tipo === "IVA" && !t.retencion).reduce((s, t) => s + t.importe, 0)
    : ivaMatch
      ? parseFloat(ivaMatch[1])
      : total - subtotal;

  // Emisor
  const rfcEmisor = attrIn("Emisor", "Rfc", "rfc");
  const nombreEmisor = attrIn("Emisor", "Nombre", "nombre");
  // En 3.2 el régimen es un NODO HIJO con texto libre («Régimen General de Ley
  // Personas Morales»), no una clave del catálogo. Se deja null a propósito:
  // guardar ese texto donde va una clave de tres dígitos sería peor que no
  // guardar nada — el default (616) al menos es una clave válida.
  const regimenEmisor = es32 ? null : attrIn("Emisor", "RegimenFiscal");

  // Receptor. En CFDI 4.0 el nodo lleva CUATRO atributos de identidad fiscal y
  // los cuatro son obligatorios: Rfc, Nombre, DomicilioFiscalReceptor (CP) y
  // RegimenFiscalReceptor. Se leían sólo los dos primeros y los otros dos se
  // tiraban — siendo que un CFDI TIMBRADO ya pasó la validación del padrón, así
  // que son, por definición, los datos exactos del cliente ante el SAT.
  //
  // Los dos últimos NO tienen variante en minúsculas porque NO EXISTEN en 3.2
  // ni en 3.3: llegaron con 4.0. En un comprobante viejo salen null, y de ahí
  // no se llena nada — que es lo correcto.
  const rfcReceptor = attrIn("Receptor", "Rfc", "rfc");
  const nombreReceptor = attrIn("Receptor", "Nombre", "nombre");
  const cpRec = attrIn("Receptor", "DomicilioFiscalReceptor");
  const domicilioFiscalReceptor = cpRec && /^\d{5}$/.test(cpRec.trim()) ? cpRec.trim() : null;
  const regimenFiscalReceptor = attrIn("Receptor", "RegimenFiscalReceptor");

  // Folio / Serie (optional, root attrs)
  const serie = rootAttr("Serie") ?? rootAttr("serie");
  const folio = rootAttr("Folio") ?? rootAttr("folio");

  // Conceptos — extract each <cfdi:Concepto ... /> or <cfdi:Concepto>...</cfdi:Concepto>
  const items: Array<{
    claveProdServ: string;
    claveUnidad: string;
    unidad: string | null;
    cantidad: number;
    descripcion: string;
    valorUnitario: number;
    importe: number;
    descuento: number;
    /** Cuentas prediales del concepto (arrendamiento). CFDI 4.0 permite varias. */
    cuentasPrediales: string[];
  }> = [];

  const conceptoRe = /<(?:[a-zA-Z0-9]+:)?Concepto\b([^>]*)(?:\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = conceptoRe.exec(xml)) !== null) {
    const attrs = m[1];
    // CuentaPredial es un nodo HIJO del concepto, no un atributo: hay que mirar
    // el cuerpo. Un concepto autocerrado (<Concepto ... />) no puede tenerlo.
    let cuerpoConcepto = "";
    if (!m[0].endsWith("/>")) {
      const resto = xml.slice(conceptoRe.lastIndex);
      const cierre = resto.search(/<\/(?:[a-zA-Z0-9]+:)?Concepto>/);
      cuerpoConcepto = cierre === -1 ? "" : resto.slice(0, cierre);
    }
    const getAttr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const get2 = (...names: string[]) => {
      for (const n of names) {
        const v = getAttr(n);
        if (v != null) return v;
      }
      return null;
    };
    const cps = getAttr("ClaveProdServ");
    // Un 3.3/4.0 SIN ClaveProdServ está malformado y se descarta, como antes.
    // Un 3.2 nunca la trae —el catálogo no existía— así que descartarlo por eso
    // borraba TODOS los conceptos del comprobante: quedaba una factura con
    // total y sin una sola línea.
    if (!cps && !es32) continue;
    items.push({
      claveProdServ: cps ?? CLAVE_PROD_SERV_SIN_CATALOGO,
      claveUnidad: get2("ClaveUnidad") ?? "E48",
      unidad: get2("Unidad", "unidad"),
      cantidad: parseFloat(get2("Cantidad", "cantidad") ?? "1"),
      descripcion: get2("Descripcion", "descripcion") ?? "",
      valorUnitario: parseFloat(get2("ValorUnitario", "valorUnitario") ?? "0"),
      importe: parseFloat(get2("Importe", "importe") ?? "0"),
      descuento: parseFloat(get2("Descuento", "descuento") ?? "0"),
      cuentasPrediales: cuentasPredialesDeConcepto(cuerpoConcepto),
    });
  }

  // Complemento de Pago (tipo P): each <pago:Pago> node carries the payment date
  // (FechaPago) and one or more DoctoRelacionado children naming the parent
  // invoice(s) it settles. Capturing these links a REP to the invoice it pays —
  // for both emitidos (do I still owe a REP?) and recibidos (did my vendor send
  // the REP for a gasto I paid?).
  //
  // Complemento 2.0 adds a per-docto IVA breakdown (ImpuestosDR/TrasladoDR) —
  // the firm, payment-level IVA the SAT expects. Complemento 1.0 (legacy, CFDI
  // 3.3) carries no breakdown, so IVA for those is flagged `ivaDerivado` and
  // prorated from the parent invoice downstream. We walk per-Pago so FechaPago
  // and each TrasladoDR stay bound to the right DoctoRelacionado. The regexes
  // are namespace-agnostic (pago10/pago20).
  const doctosRelacionados: Array<{
    uuid: string;
    impPagado: number | null;
    numParcialidad: number | null;
    impSaldoAnterior: number | null;
    impSaldoInsoluto: number | null;
    fechaPago: string | null;
    baseTraslado: number | null;
    ivaTrasladado: number | null;
    ivaDerivado: boolean;
  }> = [];

  const pagoRe = /<(?:[a-zA-Z0-9]+:)?Pago\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?Pago>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pagoRe.exec(xml)) !== null) {
    const pagoAttrs = pm[1];
    const pagoBody = pm[2];
    const fechaPago = /\bFechaPago="([^"]*)"/.exec(pagoAttrs)?.[1] ?? null;

    // Each DoctoRelacionado is self-closing (1.0) or wraps ImpuestosDR (2.0).
    const doctoRe = /<(?:[a-zA-Z0-9]+:)?DoctoRelacionado\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?DoctoRelacionado>)/g;
    let dm: RegExpExecArray | null;
    while ((dm = doctoRe.exec(pagoBody)) !== null) {
      const attrs = dm[1];
      const body = dm[2] ?? "";
      const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
      const id = get("IdDocumento");
      if (!id) continue;

      // Per-docto IVA breakdown (complemento 2.0). ImpuestoDR "002" = IVA.
      let baseTraslado: number | null = null;
      let ivaTrasladado: number | null = null;
      let sawTraslado = false;
      const trasladoRe = /<(?:[a-zA-Z0-9]+:)?TrasladoDR\b([^>]*?)\/?>/g;
      let tm: RegExpExecArray | null;
      while ((tm = trasladoRe.exec(body)) !== null) {
        const tAttrs = tm[1];
        const tget = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tAttrs)?.[1] ?? null;
        if (tget("ImpuestoDR") !== "002") continue; // IVA only
        sawTraslado = true;
        baseTraslado = (baseTraslado ?? 0) + (numOf(tget("BaseDR")) ?? 0);
        ivaTrasladado = (ivaTrasladado ?? 0) + (numOf(tget("ImporteDR")) ?? 0);
      }

      // Decide whether IVA is firm, a firm zero, or must be derived downstream.
      const objetoImp = get("ObjetoImpDR"); // null in 1.0
      let ivaDerivado = false;
      if (!sawTraslado) {
        if (objetoImp === "01") {
          // 2.0, explicitly "no objeto de impuesto" → firm zero.
          baseTraslado = 0;
          ivaTrasladado = 0;
        } else {
          // 1.0 (no breakdown) or 2.0 ObjetoImpDR "03" (no desglose) → derive.
          ivaDerivado = true;
        }
      }

      doctosRelacionados.push({
        uuid: id.toUpperCase(),
        impPagado: numOf(get("ImpPagado")),
        numParcialidad: numOf(get("NumParcialidad")),
        impSaldoAnterior: numOf(get("ImpSaldoAnt")),
        impSaldoInsoluto: numOf(get("ImpSaldoInsoluto")),
        fechaPago,
        baseTraslado,
        ivaTrasladado,
        ivaDerivado,
      });
    }
  }

  // ── Complemento de Nómina (CFDI tipo "N") ──────────────────────────────────
  // El <nomina12:Nomina> trae el régimen del receptor y el ISR retenido por el
  // patrón/retenedor — datos que el import antes descartaba. Para asimilados a
  // salarios recibidos (régimen 05–11, Art. 94 LISR) el ISR retenido es
  // acreditable del receptor y la percepción es ingreso por ese régimen.
  let nomina: {
    tipoNomina: string | null;
    tipoRegimen: string | null;
    totalPercepciones: number | null;
    totalDeducciones: number | null;
    totalOtrosPagos: number | null;
    isrRetenido: number | null;
  } | null = null;
  if (tipo === "N") {
    const nominaAttrs = /<(?:[a-zA-Z0-9]+:)?Nomina\b([^>]*)>/.exec(xml)?.[1] ?? "";
    const nAttr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(nominaAttrs)?.[1] ?? null;
    // El régimen vive en el Receptor del complemento (TipoRegimen), no en el
    // cfdi:Receptor — lo buscamos por su atributo directamente.
    const tipoRegimen =
      /<(?:[a-zA-Z0-9]+:)?Receptor\b[^>]*\bTipoRegimen="([^"]*)"/.exec(xml)?.[1] ?? null;
    // ISR retenido = suma de Deduccion TipoDeduccion="002".
    let isrRetenido: number | null = null;
    const dedRe = /<(?:[a-zA-Z0-9]+:)?Deduccion\b([^>]*?)\/?>/g;
    let dmn: RegExpExecArray | null;
    while ((dmn = dedRe.exec(xml)) !== null) {
      const a = dmn[1];
      const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(a)?.[1] ?? null;
      if (get("TipoDeduccion") === "002") isrRetenido = (isrRetenido ?? 0) + (numOf(get("Importe")) ?? 0);
    }
    nomina = {
      tipoNomina: nAttr("TipoNomina"),
      tipoRegimen,
      totalPercepciones: numOf(nAttr("TotalPercepciones")),
      totalDeducciones: numOf(nAttr("TotalDeducciones")),
      totalOtrosPagos: numOf(nAttr("TotalOtrosPagos")),
      isrRetenido,
    };
  }

  // ── CfdiRelacionados ───────────────────────────────────────────────────────
  // El nodo que dice a qué OTRO comprobante apunta éste: TipoRelacion 04 lo
  // sustituye, 01 es la nota de crédito que lo corrige, 07 es el CFDI que
  // aplica un anticipo. Sin esto, una nota de crédito y su factura son dos
  // documentos sueltos y el neteo se tiene que adivinar por importe y fecha.
  //
  // El CFDI 4.0 permite VARIOS nodos CfdiRelacionados (uno por TipoRelacion) y
  // cada uno con varios hijos, así que se devuelven todos. Quien sólo tenga dos
  // columnas escalares que llenar toma el primero, pero el dato no se pierde
  // aquí.
  const relacionados: Array<{ tipoRelacion: string; uuids: string[] }> = [];
  const relRe =
    /<(?:[a-zA-Z0-9]+:)?CfdiRelacionados\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?CfdiRelacionados>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(xml)) !== null) {
    const tipoRel = /\bTipoRelacion="([^"]*)"/.exec(rm[1] ?? "")?.[1]?.trim();
    if (!tipoRel) continue;
    const uuids: string[] = [];
    for (const r of (rm[2] ?? "").matchAll(/<(?:[a-zA-Z0-9]+:)?CfdiRelacionado\b([^>]*?)\/?>/g)) {
      // Mismo criterio que el UUID del timbre: mayúsculas, o el mismo folio
      // fiscal escrito en dos cajas distintas no empata consigo mismo.
      const u = /\bUUID="([^"]*)"/.exec(r[1] ?? "")?.[1]?.trim().toUpperCase();
      if (u) uuids.push(u);
    }
    if (uuids.length > 0) relacionados.push({ tipoRelacion: tipoRel, uuids });
  }

  return {
    uuid,
    fecha,
    tipo,
    serie,
    folio,
    relacionados,
    subtotal,
    total,
    ivaTotal,
    formaPago,
    metodoPago,
    usoCfdi,
    moneda,
    rfcEmisor,
    nombreEmisor,
    regimenEmisor,
    rfcReceptor,
    nombreReceptor,
    domicilioFiscalReceptor,
    regimenFiscalReceptor,
    items,
    taxes,
    doctosRelacionados,
    nomina,
  };
}
