// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap del roster de nómina desde los CFDIs de nómina de la propia empresa.
//
// La empresa es el EMISOR de sus propios recibos de nómina (CFDI tipo "N"); el
// RECEPTOR es el trabajador. Reconstruimos la lista de empleados, su salario
// vigente, periodicidad y estado (activo / probable baja / baja) a partir del
// complemento de nómina 1.2 guardado en Invoice.rawXml.
//
// Tres piezas, separadas a propósito:
//   1. parseComplementoNomina(rawXml)  — PURA, sin DB. Lee un recibo.
//   2. clasificarEmpleado({...})        — PURA, sin DB. Decide el estado.
//   3. detectarRosterDesdeCfdis(...)    — lee la DB, agrupa por RFC, clasifica.
//
// Nada se crea en silencio: el aggregator es de SÓLO LECTURA y la importación
// ocurre únicamente cuando el usuario confirma (ver /api/nomina/roster-import).
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Parser PURO del complemento de nómina 1.2 ────────────────────────────

export interface ComplementoNomina {
  /** RFC del receptor (el trabajador). Mayúsculas. */
  rfc: string;
  /** Nombre del receptor tal cual viene en el cfdi:Receptor. */
  nombre: string | null;
  curp: string | null;
  nss: string | null;
  /** FechaInicioRelLaboral del Receptor del complemento (ISO date). */
  fechaInicioRelLaboral: string | null;
  tipoContrato: string | null;
  tipoRegimen: string | null;
  puesto: string | null;
  departamento: string | null;
  riesgoPuesto: string | null;
  periodicidadPago: string | null;
  /** SalarioBaseCotApor (SBC). */
  sbc: number | null;
  /** SalarioDiarioIntegrado (SDI). */
  sdi: number | null;
  /** "O" ordinaria | "E" extraordinaria. */
  tipoNomina: string | null;
  /** FechaPago del nodo Nomina (ISO date). */
  fechaPago: string | null;
  totalPercepciones: number | null;
  /**
   * True si el recibo trae una percepción de separación/indemnización
   * (TipoPercepcion 022/023/025) o el nodo SeparacionIndemnizacion — señal de
   * finiquito/liquidación, i.e. baja del trabajador.
   */
  esFiniquito: boolean;
}

// Atributo en cualquier parte del XML.
function attr(xml: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? null;
}

// Atributo dentro del primer tag (con o sin namespace) que tenga el nombre dado.
function attrInTag(xml: string, tag: string, name: string): string | null {
  const tagMatch = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>`).exec(xml);
  if (!tagMatch) return null;
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tagMatch[0])?.[1] ?? null;
}

function numOrNull(v: string | null): number | null {
  return v != null && v !== "" ? Number(v) : null;
}

/**
 * Parsea un CFDI de nómina (tipo "N") y devuelve los datos del trabajador del
 * complemento de nómina 1.2. Devuelve null si:
 *   - el XML no se puede leer / está vacío,
 *   - no es un CFDI tipo "N", o
 *   - no trae complemento de nómina (nodo Nomina con Receptor).
 *
 * NO lanza: ante XML basura devuelve null para que el agregador lo cuente como
 * "omitido" y siga con los demás recibos.
 */
export function parseComplementoNomina(rawXml: string | null | undefined): ComplementoNomina | null {
  if (!rawXml || rawXml.trim() === "") return null;

  const tipo = attr(rawXml, "TipoDeComprobante");
  if (tipo !== "N") return null;

  // El nodo Nomina del complemento (namespace nomina12). Sin él no hay recibo.
  const nominaTag = /<(?:[a-zA-Z0-9]+:)?Nomina\b([^>]*)>/.exec(rawXml);
  if (!nominaTag) return null;
  const nominaAttrs = nominaTag[1];

  // El Receptor del complemento (nomina12:Receptor) — distinto del cfdi:Receptor.
  // Trae los datos laborales. Lo aislamos por sus atributos característicos.
  const compReceptor =
    /<(?:[a-zA-Z0-9]+:)?Receptor\b([^>]*\b(?:Curp|TipoRegimen|NumEmpleado|SalarioBaseCotApor|FechaInicioRelLaboral)=[^>]*)>/.exec(
      rawXml
    )?.[1] ?? "";

  // RFC del trabajador vive en el cfdi:Receptor (el complemento no lo repite).
  const rfc = attrInTag(rawXml, "Receptor", "Rfc")?.toUpperCase() ?? null;
  if (!rfc) return null; // sin RFC no podemos agrupar al empleado

  const nombre = attrInTag(rawXml, "Receptor", "Nombre");

  const nAttr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(nominaAttrs)?.[1] ?? null;
  const rAttr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(compReceptor)?.[1] ?? null;

  // Señal de finiquito/baja: percepción de separación (022 Pagos por separación,
  // 023 Jubilación pago único, 025 Indemnización/separación) o el nodo
  // SeparacionIndemnizacion del complemento.
  const SEPARACION_CODES = new Set(["022", "023", "025"]);
  let esFiniquito = /<(?:[a-zA-Z0-9]+:)?SeparacionIndemnizacion\b/.test(rawXml);
  if (!esFiniquito) {
    const percRe = /<(?:[a-zA-Z0-9]+:)?Percepcion\b([^>]*?)\/?>/g;
    let pm: RegExpExecArray | null;
    while ((pm = percRe.exec(rawXml)) !== null) {
      const tipoPerc = /\bTipoPercepcion="([^"]*)"/.exec(pm[1])?.[1];
      if (tipoPerc && SEPARACION_CODES.has(tipoPerc)) {
        esFiniquito = true;
        break;
      }
    }
  }

  return {
    rfc,
    nombre,
    curp: rAttr("Curp"),
    nss: rAttr("NumSeguridadSocial"),
    fechaInicioRelLaboral: rAttr("FechaInicioRelLaboral"),
    tipoContrato: rAttr("TipoContrato"),
    tipoRegimen: rAttr("TipoRegimen"),
    puesto: rAttr("Puesto"),
    departamento: rAttr("Departamento"),
    riesgoPuesto: rAttr("RiesgoPuesto"),
    periodicidadPago: rAttr("PeriodicidadPago"),
    sbc: numOrNull(rAttr("SalarioBaseCotApor")),
    sdi: numOrNull(rAttr("SalarioDiarioIntegrado")),
    tipoNomina: nAttr("TipoNomina"),
    fechaPago: nAttr("FechaPago"),
    totalPercepciones: numOrNull(nAttr("TotalPercepciones")),
    esFiniquito,
  };
}

// ── 2. Clasificador PURO del estado del empleado ────────────────────────────

export type EstadoEmpleado = "ACTIVO" | "PROBABLE_BAJA" | "BAJA";

/** Un recibo, reducido a lo que el clasificador necesita. */
export interface ReciboEvento {
  /** Fecha de pago del recibo. */
  fechaPago: Date;
  /** "O" ordinaria | "E" extraordinaria | null. */
  tipoNomina: string | null;
  /** True si el recibo es de separación/indemnización. */
  esFiniquito: boolean;
}

// Periodicidad SAT → días aproximados de un periodo de pago.
const DIAS_POR_PERIODO: Record<string, number> = {
  "01": 1, // Diario
  "02": 7, // Semanal
  "03": 14, // Catorcenal
  "04": 15, // Quincenal
  "05": 30, // Mensual
  "06": 60, // Bimestral (poco común en sueldos)
  "07": 7, // Por unidad de obra (tratado como semanal)
  "08": 7, // Comisión
  "09": 1, // Precio alzado
  "10": 15, // Decena
  "99": 15, // Otra
};

/** Ventana activa = ~2 periodos de pago, con tope duro de 90 días. */
function ventanaActivaDias(cadencia: string | null): number {
  const dias = (cadencia && DIAS_POR_PERIODO[cadencia]) || 15;
  return Math.min(dias * 2 + 5, 90); // +5 días de gracia por demoras de timbrado
}

/**
 * Decide el estado de un empleado a partir de sus recibos.
 *
 * Reglas (en orden):
 *   BAJA          — el evento MÁS RECIENTE es un finiquito/separación.
 *   ACTIVO        — hay un recibo ORDINARIO dentro de la ventana activa
 *                   (≈2 periodos de pago; tope duro de 90 días).
 *   PROBABLE_BAJA — todo lo demás: sin recibo reciente y sin finiquito
 *                   (p. ej. permiso sin goce / incapacidad larga → NO se
 *                   descarta, queda para revisión del usuario).
 *
 * NUNCA descarta: todo empleado con al menos un recibo cae en un bucket.
 */
export function clasificarEmpleado(input: {
  recibos: ReciboEvento[];
  hoy: Date;
  cadencia: string | null;
}): EstadoEmpleado {
  const { recibos, hoy, cadencia } = input;
  if (recibos.length === 0) return "PROBABLE_BAJA";

  // Ordenados del más reciente al más antiguo.
  const ordenados = [...recibos].sort((a, b) => b.fechaPago.getTime() - a.fechaPago.getTime());
  const ultimo = ordenados[0];

  if (ultimo.esFiniquito) return "BAJA";

  const ventana = ventanaActivaDias(cadencia);
  const limite = new Date(hoy.getTime() - ventana * 24 * 60 * 60 * 1000);

  const hayOrdinarioReciente = ordenados.some(
    (r) => !r.esFiniquito && r.tipoNomina !== "E" && r.fechaPago >= limite
  );
  if (hayOrdinarioReciente) return "ACTIVO";

  return "PROBABLE_BAJA";
}

// ── 3. Agregador (lee la DB) ────────────────────────────────────────────────

export interface RosterSugerido {
  rfc: string;
  nombre: string | null;
  /** Apellidos derivados del nombre (heurística simple, editable por el usuario). */
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  nombrePila: string;
  curp: string | null;
  nss: string | null;
  fechaIngreso: string | null;
  tipoContrato: string | null;
  tipoRegimen: string | null;
  puesto: string | null;
  departamento: string | null;
  riesgoPuesto: string | null;
  periodicidadPago: string | null;
  salarioDiario: number | null;
  salarioDiarioIntegrado: number | null;
  /** Fecha de pago del último recibo (ISO). */
  ultimoRecibo: string | null;
  estado: EstadoEmpleado;
  /** Cuántos recibos se contaron para este empleado. */
  numRecibos: number;
  /** True si este RFC ya existe como Employee en la empresa. */
  yaExiste: boolean;
}

export interface DeteccionRosterResult {
  roster: RosterSugerido[];
  counts: {
    /** Total de CFDIs de nómina (tipo N) de la empresa. */
    totalRecibos: number;
    /** Recibos sin rawXml que no pudimos parsear (sugerir re-sincronizar). */
    sinRawXml: number;
    /** Recibos con rawXml que no parsearon (XML ilegible o sin complemento). */
    noParseables: number;
    /** Empleados detectados (RFCs únicos). */
    empleados: number;
    activos: number;
    probablesBajas: number;
    bajas: number;
    /** Empleados ya existentes como Employee (se omiten al importar). */
    yaExisten: number;
  };
}

/** Deriva nombre de pila / apellidos de un nombre completo "NOMBRE AP AM". */
function partirNombre(nombre: string | null): {
  nombrePila: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
} {
  const limpio = (nombre ?? "").trim().replace(/\s+/g, " ");
  if (!limpio) return { nombrePila: "", apellidoPaterno: "", apellidoMaterno: null };
  const partes = limpio.split(" ");
  // Heurística: en CFDI el nombre suele venir "NOMBRE(S) APELLIDO_P APELLIDO_M".
  // No es confiable al 100% — el usuario corrige en el paso de revisión.
  if (partes.length === 1) return { nombrePila: partes[0], apellidoPaterno: "", apellidoMaterno: null };
  if (partes.length === 2)
    return { nombrePila: partes[0], apellidoPaterno: partes[1], apellidoMaterno: null };
  if (partes.length === 3)
    return { nombrePila: partes[0], apellidoPaterno: partes[1], apellidoMaterno: partes[2] };
  // 4+: nombre = primeros (n-2), apellidos = últimos 2.
  const apM = partes[partes.length - 1];
  const apP = partes[partes.length - 2];
  const pila = partes.slice(0, partes.length - 2).join(" ");
  return { nombrePila: pila, apellidoPaterno: apP, apellidoMaterno: apM };
}

interface MinimalPrisma {
  company: { findUnique(args: unknown): Promise<{ rfc: string } | null> };
  invoice: {
    findMany(args: unknown): Promise<Array<{ rawXml: string | null }>>;
  };
  employee: { findMany(args: unknown): Promise<Array<{ rfc: string }>> };
}

/**
 * Reconstruye el roster sugerido a partir de los CFDIs de nómina propios de la
 * empresa (la empresa es el EMISOR). SÓLO LECTURA: no crea ni modifica nada.
 *
 * @param prismaClient inyectable para test; en producción pasa `prisma`.
 */
export async function detectarRosterDesdeCfdis(
  companyId: string,
  hoy: Date,
  prismaClient: MinimalPrisma
): Promise<DeteccionRosterResult> {
  const emptyCounts = {
    totalRecibos: 0,
    sinRawXml: 0,
    noParseables: 0,
    empleados: 0,
    activos: 0,
    probablesBajas: 0,
    bajas: 0,
    yaExisten: 0,
  };

  const company = await prismaClient.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });
  if (!company) return { roster: [], counts: emptyCounts };

  // CFDIs de nómina PROPIOS: tipo N donde la empresa es el emisor. Filtramos por
  // companyId (la dedup de importación ya es por empresa) y descartamos los
  // cancelados. No exigimos rawXml aquí para poder contar los que faltan.
  const recibos = await prismaClient.invoice.findMany({
    where: {
      companyId,
      tipo: "NOMINA",
      status: { not: "CANCELLED" },
    },
    select: { rawXml: true },
  });

  const existentes = await prismaClient.employee.findMany({
    where: { companyId },
    select: { rfc: true },
  });
  const rfcsExistentes = new Set(existentes.map((e) => e.rfc.toUpperCase()));

  let sinRawXml = 0;
  let noParseables = 0;

  interface Acum {
    recibos: ReciboEvento[];
    /** El recibo ordinario más reciente (fuente del salario/puesto vigente). */
    ultimoOrdinario: { fechaPago: Date; comp: ComplementoNomina } | null;
    /** Cualquier recibo más reciente (para fechas y fallback de datos). */
    ultimoCualquiera: { fechaPago: Date; comp: ComplementoNomina } | null;
  }
  const porRfc = new Map<string, Acum>();

  for (const inv of recibos) {
    if (!inv.rawXml) {
      sinRawXml++;
      continue;
    }
    const comp = parseComplementoNomina(inv.rawXml);
    if (!comp) {
      noParseables++;
      continue;
    }
    const fechaPago = comp.fechaPago ? new Date(comp.fechaPago) : null;
    if (!fechaPago || isNaN(fechaPago.getTime())) {
      noParseables++;
      continue;
    }

    const evento: ReciboEvento = {
      fechaPago,
      tipoNomina: comp.tipoNomina,
      esFiniquito: comp.esFiniquito,
    };

    const key = comp.rfc;
    let acc = porRfc.get(key);
    if (!acc) {
      acc = { recibos: [], ultimoOrdinario: null, ultimoCualquiera: null };
      porRfc.set(key, acc);
    }
    acc.recibos.push(evento);

    if (!acc.ultimoCualquiera || fechaPago > acc.ultimoCualquiera.fechaPago) {
      acc.ultimoCualquiera = { fechaPago, comp };
    }
    const esOrdinario = !comp.esFiniquito && comp.tipoNomina !== "E";
    if (esOrdinario && (!acc.ultimoOrdinario || fechaPago > acc.ultimoOrdinario.fechaPago)) {
      acc.ultimoOrdinario = { fechaPago, comp };
    }
  }

  const roster: RosterSugerido[] = [];
  let activos = 0;
  let probablesBajas = 0;
  let bajas = 0;

  for (const [rfc, acc] of porRfc) {
    // El recibo ORDINARIO más reciente manda para salario/puesto/curp/nss; si no
    // hubo ninguno ordinario (p. ej. sólo finiquito), usamos el más reciente.
    const fuente = (acc.ultimoOrdinario ?? acc.ultimoCualquiera)!.comp;
    const cadencia = fuente.periodicidadPago;
    const estado = clasificarEmpleado({ recibos: acc.recibos, hoy, cadencia });

    if (estado === "ACTIVO") activos++;
    else if (estado === "PROBABLE_BAJA") probablesBajas++;
    else bajas++;

    const nombrePartes = partirNombre(fuente.nombre);

    roster.push({
      rfc,
      nombre: fuente.nombre,
      ...nombrePartes,
      curp: fuente.curp,
      nss: fuente.nss,
      // fechaIngreso = FechaInicioRelLaboral del recibo fuente.
      fechaIngreso: fuente.fechaInicioRelLaboral,
      tipoContrato: fuente.tipoContrato,
      tipoRegimen: fuente.tipoRegimen,
      puesto: fuente.puesto,
      departamento: fuente.departamento,
      riesgoPuesto: fuente.riesgoPuesto,
      periodicidadPago: fuente.periodicidadPago,
      salarioDiario: fuente.sbc,
      salarioDiarioIntegrado: fuente.sdi,
      ultimoRecibo: acc.ultimoCualquiera
        ? acc.ultimoCualquiera.fechaPago.toISOString().slice(0, 10)
        : null,
      estado,
      numRecibos: acc.recibos.length,
      yaExiste: rfcsExistentes.has(rfc),
    });
  }

  // Orden estable: activos primero, luego probables, luego bajas; alfabético.
  const ordenEstado: Record<EstadoEmpleado, number> = { ACTIVO: 0, PROBABLE_BAJA: 1, BAJA: 2 };
  roster.sort(
    (a, b) =>
      ordenEstado[a.estado] - ordenEstado[b.estado] ||
      (a.nombre ?? a.rfc).localeCompare(b.nombre ?? b.rfc)
  );

  return {
    roster,
    counts: {
      totalRecibos: recibos.length,
      sinRawXml,
      noParseables,
      empleados: porRfc.size,
      activos,
      probablesBajas,
      bajas,
      yaExisten: roster.filter((r) => r.yaExiste).length,
    },
  };
}
