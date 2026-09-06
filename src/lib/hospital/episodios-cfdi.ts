// ─────────────────────────────────────────────────────────────────────────────
// Expedientes históricos derivados de los CFDIs (P4).
//
// Un hospital que ya facturaba antes del módulo no tiene episodios, pero su
// historia clínico-comercial está entera en las facturas: quién fue atendido,
// cuándo, de qué y quién pagó. Esto la reconstruye SIN capturar nada:
//
//   · Fuente: CFDIs de INGRESO (tipoSat I) no cancelados que todavía no
//     amparan ningún HospCargo. Esa es la idempotencia: el cargo derivado
//     guarda su `invoiceId`, así que una segunda corrida no ve esa factura.
//   · Paciente: si el receptor es persona física, el paciente es él (o el que
//     ya cuelga de su RFC: un padre puede pagar por su hijo); si es persona
//     moral —aseguradora o empresa—, el nombre sólo existe en los conceptos
//     («… px Rafael Jiménez Torres»). Sin nombre no hay episodio: la factura
//     se reporta para que alguien la vea.
//   · Episodio: los CFDIs del mismo paciente a ≤ 7 días son UNA atención (el
//     hospital factura la estancia en dos exhibiciones). Nace ALTA, con
//     origen CFDI y sin documentos requeridos ni cargos de estancia: no es un
//     ingreso vivo, es historia. Tampoco se le inventa médico ni cama.
//   · Cargos: un renglón por concepto, con su categoría, su IVA y su factura,
//     para que la cuenta y la cobranza funcionen igual que en un episodio
//     capturado en piso.
//
// Resiliencia: el proxy público de Postgres corta conexiones largas, así que
// se lee por páginas y se escribe UNA TRANSACCIÓN POR EPISODIO — nunca una
// transacción gigante que se caiga a la mitad y deje medio hospital.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCargoCategoria, HospEpisodioTipo, HospPagadorTipo, PrismaClient } from "@prisma/client";
import { categoriaDe, nombreDePaciente, nombrePropio, normalizarDescripcion, partirNombre } from "./cfdi-texto";
import { conFolioUnico, siguienteFolio } from "./folio";
import { diasEntre } from "./tz";
import { ivaDefault, r2 } from "./util";

// ─── Formas de entrada ───────────────────────────────────────────────────────

export interface ConceptoFactura {
  descripcion: string | null;
  cantidad?: unknown;
  valorUnitario?: unknown;
  importe?: unknown;
}

/** Un CFDI de ingreso como lo necesita la derivación (Decimal ya como número). */
export interface FacturaCfdi {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  fecha: Date;
  subtotal: number;
  totalImpuestos: number;
  total: number;
  /** Receptor fiscal (Customer del hub); null a público en general. */
  customerId: string | null;
  receptorRfc: string | null;
  receptorNombre: string | null;
  items: ConceptoFactura[];
}

/** «A-1234», si no el UUID corto, si no el id: cómo se nombra el CFDI en las notas. */
export function referenciaCfdi(f: { serie: string | null; folio: string | null; uuid: string | null; id: string }): string {
  const sf = [f.serie?.trim(), f.folio?.trim()].filter(Boolean).join("-");
  return sf || f.uuid?.slice(0, 8).toUpperCase() || f.id;
}

// ─── Tipo de episodio ────────────────────────────────────────────────────────

// «FARMACIA HOSPITALARIA» es el nombre del área, no una estancia: si no se
// desarma, cualquier consulta con medicamentos se volvería hospitalización.
const RE_FARMACIA_HOSPITALARIA = /FARMACIA HOSPITALARIA/g;
const RE_HOSPITALIZACION = /HOSPITALIZACION|HOSPITALARI|HABITACION|ESTANCIA|CUARTO|TERAPIA INTENSIVA|CUIDADOS INTENSIVOS|CUNERO/;
const RE_URGENCIAS = /URGENCIA/;
const RE_AMBULATORIO = /QUIROFANO|ENDOSCOPIA|COLONOSCOPIA|CISTOSCOPIA|CIRUGIA|QUIRURGIC|BIOPSIA|PAQUETE|PROCEDIMIENTO/;

/**
 * Qué tipo de atención cuentan los conceptos del CFDI, de lo más específico a
 * lo más general: hospitalización > urgencias > ambulatorio > consulta.
 */
export function tipoEpisodioPorConceptos(descripciones: Array<string | null | undefined>): HospEpisodioTipo {
  const texto = descripciones
    .map((d) => normalizarDescripcion(d))
    .join(" | ")
    .replace(RE_FARMACIA_HOSPITALARIA, "FARMACIA");
  if (RE_HOSPITALIZACION.test(texto)) return "HOSPITALIZACION";
  if (RE_URGENCIAS.test(texto)) return "URGENCIAS";
  if (RE_AMBULATORIO.test(texto)) return "AMBULATORIO";
  return "CONSULTA";
}

// ─── Agrupación en episodios ─────────────────────────────────────────────────

/**
 * Los CFDIs del mismo paciente separados por ≤ `diasVentana` días son UNA
 * atención. La ventana se mide contra la ÚLTIMA factura del grupo (una
 * estancia larga se factura en varias exhibiciones consecutivas), y los días
 * son locales: 29-ago y 31-ago son 2 días, no 47 horas.
 */
export function agruparFacturasEnEpisodios<T extends { fecha: Date; pacienteKey: string }>(
  facturas: T[],
  opts: { diasVentana?: number } = {}
): T[][] {
  const diasVentana = opts.diasVentana ?? 7;
  const porPaciente = new Map<string, T[]>();
  for (const f of facturas) {
    const lista = porPaciente.get(f.pacienteKey) ?? [];
    lista.push(f);
    porPaciente.set(f.pacienteKey, lista);
  }
  const grupos: T[][] = [];
  for (const lista of porPaciente.values()) {
    lista.sort((a, b) => +a.fecha - +b.fecha);
    let actual: T[] = [];
    for (const f of lista) {
      const ultima = actual[actual.length - 1];
      if (ultima && diasEntre(ultima.fecha, f.fecha) > diasVentana) {
        grupos.push(actual);
        actual = [];
      }
      actual.push(f);
    }
    if (actual.length) grupos.push(actual);
  }
  return grupos.sort((a, b) => +a[0].fecha - +b[0].fecha);
}

// ─── Paciente de una factura ─────────────────────────────────────────────────

/** RFCs genéricos del SAT: público en general y extranjeros. No son una persona. */
const RFC_GENERICO = new Set(["XAXX010101000", "XEXX010101000"]);

export type ModoPaciente = "RECEPTOR" | "CONCEPTO" | "SIN_NOMBRE";

export interface PacienteDeFactura {
  modo: ModoPaciente;
  /** Nombre completo normalizado: con esta llave se agrupa y se busca. */
  llave: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  /**
   * Receptor fiscal que le toca al PACIENTE: sólo cuando el receptor del CFDI
   * es persona física. A la aseguradora la lleva el pagador, no el paciente.
   */
  customerId: string | null;
  /** Por qué no se pudo identificar (sólo en SIN_NOMBRE). */
  motivo: string | null;
}

const SIN_NOMBRE = (motivo: string): PacienteDeFactura => ({
  modo: "SIN_NOMBRE",
  llave: "",
  nombre: "",
  apellidoPaterno: "",
  apellidoMaterno: null,
  customerId: null,
  motivo,
});

/** El primer concepto que nombre al paciente («px …», «paciente …»). */
export function nombreEnConceptos(items: Array<{ descripcion: string | null }>): string | null {
  for (const it of items) {
    const n = nombreDePaciente(it.descripcion ?? "");
    if (n) return n;
  }
  return null;
}

/**
 * Quién fue atendido según el CFDI. El concepto manda cuando nombra al
 * paciente —en las facturas a empresas y aseguradoras es el único lugar donde
 * aparece, y en las de persona física distingue al hijo atendido del padre que
 * paga—; si no lo nombra y el receptor es persona física, el paciente es el
 * receptor. Todo lo demás queda SIN_NOMBRE con su motivo.
 */
export function resolverPacienteDeFactura(f: {
  customerId: string | null;
  receptorRfc: string | null;
  receptorNombre: string | null;
  items: Array<{ descripcion: string | null }>;
}): PacienteDeFactura {
  const rfc = (f.receptorRfc ?? "").trim().toUpperCase();
  const esGenerico = RFC_GENERICO.has(rfc);
  const esFisica = rfc.length === 13 && !esGenerico;
  const customerId = esFisica ? f.customerId : null;

  const delConcepto = nombreEnConceptos(f.items);
  if (delConcepto) {
    const p = partirNombre(delConcepto);
    if (p.apellidoPaterno) {
      return { modo: "CONCEPTO", llave: normalizarDescripcion(delConcepto), ...p, customerId, motivo: null };
    }
  }
  if (esFisica) {
    const razon = (f.receptorNombre ?? "").trim();
    const p = partirNombre(razon);
    if (razon && p.apellidoPaterno) {
      return { modo: "RECEPTOR", llave: normalizarDescripcion(razon), ...p, customerId, motivo: null };
    }
    return SIN_NOMBRE(`el receptor «${razon || rfc}» no alcanza para nombre y apellido, y ningún concepto nombra al paciente`);
  }
  if (esGenerico) return SIN_NOMBRE("público en general: ningún concepto nombra al paciente");
  if (rfc.length === 12) return SIN_NOMBRE(`persona moral (${f.receptorNombre ?? rfc}): ningún concepto nombra al paciente`);
  return SIN_NOMBRE("el CFDI no trae receptor identificable ni nombre en los conceptos");
}

// ─── Cargos de una factura ───────────────────────────────────────────────────

export interface CargoDerivado {
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  importe: number;
  ivaTasa: number | null;
  origen: "CFDI";
  invoiceId: string;
  fecha: Date;
}

/**
 * Tasa de IVA del renglón. El hub guarda los impuestos POR COMPROBANTE
 * (`InvoiceTax` cuelga de Invoice, no del concepto), así que se deduce en tres
 * pasos: el sufijo con el que el hospital ya la escribe en la descripción
 * («FARMACIA HOSPITALARIA 16» / «FARMACIA HOSPITALARIA 0»); la proporción de
 * IVA del CFDI cuando es concluyente (todo gravado al 16 % o nada gravado); y
 * si el comprobante mezcla tasas, el default de la categoría (honorarios
 * exentos, farmacia 0 %, lo demás 16 %).
 */
export function ivaTasaDeConcepto(descripcion: string | null, categoria: HospCargoCategoria, ratio: number | null): number | null {
  const d = normalizarDescripcion(descripcion);
  if (/\b16$/.test(d)) return 0.16;
  if (/\b0$/.test(d)) return 0;
  if (ratio != null) {
    if (ratio <= 0.005) return categoria === "HONORARIO" ? null : 0;
    if (ratio >= 0.15) return 0.16;
  }
  return ivaDefault(categoria, 0.16);
}

/** Un cargo por concepto: categoría, cantidad, precio, importe, IVA y su CFDI. */
export function cargosDeFactura(factura: {
  id: string;
  fecha: Date;
  subtotal?: unknown;
  totalImpuestos?: unknown;
  items: ConceptoFactura[];
}): CargoDerivado[] {
  const subtotal = Number(factura.subtotal ?? 0);
  const impuestos = Number(factura.totalImpuestos ?? 0);
  const ratio = subtotal > 0 && Number.isFinite(impuestos) ? impuestos / subtotal : null;
  const cargos: CargoDerivado[] = [];
  for (const it of factura.items) {
    const descripcion = (it.descripcion ?? "").trim();
    const importe = r2(Number(it.importe ?? 0));
    if (!descripcion && !importe) continue;
    const cantidad = Number(it.cantidad ?? 1) || 1;
    const unitario = Number(it.valorUnitario ?? 0);
    const categoria = categoriaDe(descripcion);
    cargos.push({
      categoria,
      descripcion: descripcion || "Concepto sin descripción",
      cantidad,
      precioUnitario: r2(unitario > 0 ? unitario : importe / cantidad),
      importe,
      ivaTasa: ivaTasaDeConcepto(descripcion, categoria, ratio),
      origen: "CFDI",
      invoiceId: factura.id,
      fecha: factura.fecha,
    });
  }
  return cargos;
}

// ─── Pagador ─────────────────────────────────────────────────────────────────

/** Aseguradoras por nombre; lo demás que facture una persona moral es empresa. */
export const ASEGURADORA_RE =
  /SEGUROS?\b|ASEGURADORA|\bAXA\b|\bGNP\b|METLIFE|MAPFRE|ALLIANZ|MONTERREY|BANORTE|INBURSA|ATLAS|ZURICH|CHUBB|\bSURA\b/i;

export function tipoDePagador(razonSocial: string | null | undefined): HospPagadorTipo {
  return ASEGURADORA_RE.test(razonSocial ?? "") ? "ASEGURADORA" : "EMPRESA";
}

// ─── Derivación ──────────────────────────────────────────────────────────────

/** Cortes del proxy de Postgres: se reconecta y se repite el paso. */
const CORTES = new Set(["P1017", "P1001", "P2024"]);
export function esCorteDeConexion(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return !!code && CORTES.has(code);
}

export interface FacturaSinPaciente {
  invoiceId: string;
  uuid: string | null;
  receptor: string;
  motivo: string;
}

export interface EpisodioDerivado {
  paciente: string;
  tipo: HospEpisodioTipo;
  fechaIngreso: Date;
  fechaAlta: Date;
  facturas: string[];
  cargos: number;
  /** Total con IVA de los cargos derivados. */
  total: number;
  pagador: string | null;
}

export interface ReporteEpisodiosCfdi {
  /** CFDIs candidatos leídos (sin cargos ligados todavía). */
  facturas: number;
  episodios: number;
  cargos: number;
  pacientesNuevos: number;
  pagadoresNuevos: number;
  /** Pacientes que heredaron el convenio de sus episodios derivados. */
  pacientesConPagador: number;
  sinPaciente: FacturaSinPaciente[];
  /** Los primeros episodios, para que el `--dry-run` se pueda leer. */
  muestra: EpisodioDerivado[];
}

export interface OpcionesDerivacion {
  /** No escribe nada: sólo cuenta y describe lo que haría. */
  dry?: boolean;
  desde?: Date | null;
  hasta?: Date | null;
  diasVentana?: number;
  /** CFDIs por página al leer (el proxy corta conexiones largas). */
  lote?: number;
  /** Cuántos episodios describe `muestra`. */
  muestra?: number;
  log?: (linea: string) => void;
  /** Se ejecuta antes de reintentar tras un corte (el script desconecta ahí). */
  alReconectar?: () => Promise<void>;
  /** Sólo pruebas: espera entre reintentos. */
  esperaMs?: number;
}

const PACIENTE_SELECT = { id: true, pagadorId: true } as const;

export async function derivarEpisodiosDeCfdi(
  db: PrismaClient,
  companyId: string,
  opts: OpcionesDerivacion = {}
): Promise<ReporteEpisodiosCfdi> {
  const dry = !!opts.dry;
  const lote = opts.lote ?? 200;
  const tope = opts.muestra ?? 10;
  const log = opts.log ?? (() => {});
  const esperaMs = opts.esperaMs ?? 2000;

  const reporte: ReporteEpisodiosCfdi = {
    facturas: 0,
    episodios: 0,
    cargos: 0,
    pacientesNuevos: 0,
    pagadoresNuevos: 0,
    pacientesConPagador: 0,
    sinPaciente: [],
    muestra: [],
  };

  async function conReintento<T>(nombre: string, fn: () => Promise<T>, intentos = 6): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!esCorteDeConexion(e) || i >= intentos) throw e;
        log(`  · conexión cortada en ${nombre}; reconectando (${i}/${intentos})…`);
        await opts.alReconectar?.();
        if (esperaMs > 0) await new Promise((res) => setTimeout(res, esperaMs));
      }
    }
  }

  // ── 1. CFDIs candidatos, por páginas con cursor de id ──────────────────────
  const rango =
    opts.desde || opts.hasta
      ? { ...(opts.desde ? { gte: opts.desde } : {}), ...(opts.hasta ? { lte: opts.hasta } : {}) }
      : null;
  const facturas: FacturaCfdi[] = [];
  let cursor: string | null = null;
  for (;;) {
    const pagina = await conReintento("lectura de CFDIs", () =>
      db.invoice.findMany({
        where: {
          companyId,
          tipo: "INGRESO",
          status: { not: "CANCELLED" },
          // Legado: un CFDI sin tipoSat de una empresa vieja se asume "I".
          OR: [{ tipoSat: "I" }, { tipoSat: null }],
          // Idempotencia: la factura que ya ampara cargos no se vuelve a derivar.
          hospCargos: { none: {} },
          ...(rango ? { fecha: rango } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: {
          id: true,
          uuid: true,
          serie: true,
          folio: true,
          fecha: true,
          subtotal: true,
          totalImpuestos: true,
          total: true,
          customerId: true,
          contraparteRfc: true,
          contraparteNombre: true,
          customer: { select: { rfc: true, razonSocial: true } },
          items: { select: { descripcion: true, cantidad: true, valorUnitario: true, importe: true } },
        },
        orderBy: { id: "asc" },
        take: lote,
      })
    );
    for (const f of pagina) {
      facturas.push({
        id: f.id,
        uuid: f.uuid,
        serie: f.serie,
        folio: f.folio,
        fecha: f.fecha,
        subtotal: Number(f.subtotal),
        totalImpuestos: Number(f.totalImpuestos),
        total: Number(f.total),
        customerId: f.customerId,
        receptorRfc: f.customer?.rfc ?? f.contraparteRfc,
        receptorNombre: f.customer?.razonSocial ?? f.contraparteNombre,
        items: f.items,
      });
    }
    if (pagina.length < lote) break;
    cursor = pagina[pagina.length - 1].id;
  }
  reporte.facturas = facturas.length;
  log(`  · ${facturas.length} CFDIs de ingreso sin cargos ligados`);

  // ── 2. Paciente de cada CFDI (se crea si falta) ────────────────────────────
  const pacientes = new Map<string, { id: string; pagadorId: string | null }>();

  async function pacienteDe(ident: PacienteDeFactura, f: FacturaCfdi) {
    const enCache = pacientes.get(ident.llave);
    if (enCache) return enCache;
    let fila: { id: string; pagadorId: string | null } | null = null;
    // Modo RECEPTOR: quien ya cuelga de ese RFC es el paciente aunque se llame
    // distinto (el bootstrap lo dio de alta con el nombre del concepto).
    if (ident.modo === "RECEPTOR" && ident.customerId) {
      fila = await conReintento("paciente por receptor", () =>
        db.hospPaciente.findFirst({ where: { companyId, customerId: ident.customerId }, select: PACIENTE_SELECT, orderBy: { createdAt: "asc" } })
      );
    }
    if (!fila) {
      fila = await conReintento("paciente por nombre", () =>
        db.hospPaciente.findFirst({
          where: {
            companyId,
            nombre: { equals: ident.nombre, mode: "insensitive" },
            apellidoPaterno: { equals: ident.apellidoPaterno, mode: "insensitive" },
          },
          select: PACIENTE_SELECT,
          orderBy: { createdAt: "asc" },
        })
      );
    }
    if (!fila) {
      reporte.pacientesNuevos++;
      const datos = {
        companyId,
        nombre: ident.nombre,
        apellidoPaterno: ident.apellidoPaterno,
        apellidoMaterno: ident.apellidoMaterno,
        customerId: ident.customerId,
        // NOM-024: sin CURP hay que decir por qué. Estos nacen de una factura.
        sinCurp: true,
        sinCurpMotivo: "Derivado de CFDI: expediente histórico sin identificación capturada",
        notas: `Derivado del CFDI ${referenciaCfdi(f)} (${f.fecha.toISOString().slice(0, 10)}). Completar datos en la ficha.`,
      };
      fila = dry
        ? { id: `nuevo:${ident.llave}`, pagadorId: null }
        : await conReintento("alta de paciente", () => db.hospPaciente.create({ data: datos, select: PACIENTE_SELECT }));
    }
    pacientes.set(ident.llave, fila);
    return fila;
  }

  // ── 3. Pagador del receptor moral (se crea si falta) ───────────────────────
  const pagadores = new Map<string, { id: string; nombre: string }>();

  async function pagadorDe(f: FacturaCfdi): Promise<{ id: string; nombre: string } | null> {
    const rfc = (f.receptorRfc ?? "").trim().toUpperCase();
    // Sólo una persona moral tiene convenio; el particular paga de su bolsa.
    if (!f.customerId || rfc.length !== 12 || RFC_GENERICO.has(rfc)) return null;
    const enCache = pagadores.get(f.customerId);
    if (enCache) return enCache;
    let fila = await conReintento("pagador", () =>
      db.hospPagador.findFirst({ where: { companyId, customerId: f.customerId }, select: { id: true, nombre: true }, orderBy: { createdAt: "asc" } })
    );
    if (!fila) {
      reporte.pagadoresNuevos++;
      const nombre = nombrePropio(f.receptorNombre ?? rfc);
      const tipo = tipoDePagador(f.receptorNombre);
      fila = dry
        ? { id: `nuevo:${f.customerId}`, nombre }
        : await conReintento("alta de pagador", () =>
            db.hospPagador.create({
              data: {
                companyId,
                customerId: f.customerId,
                nombre,
                tipo,
                plazoDias: 30,
                notas: "Derivado de los CFDIs al reconstruir expedientes históricos — confirmar plazo y tabulador",
              },
              select: { id: true, nombre: true },
            })
          );
    }
    pagadores.set(f.customerId, fila);
    return fila;
  }

  // ── 4. Resolver y agrupar ─────────────────────────────────────────────────
  type Resuelta = { fecha: Date; pacienteKey: string; f: FacturaCfdi; nombre: string };
  const resueltas: Resuelta[] = [];
  for (const f of facturas) {
    const ident = resolverPacienteDeFactura(f);
    if (ident.modo === "SIN_NOMBRE") {
      reporte.sinPaciente.push({
        invoiceId: f.id,
        uuid: f.uuid,
        receptor: f.receptorNombre ?? f.receptorRfc ?? "—",
        motivo: ident.motivo ?? "sin nombre de paciente",
      });
      continue;
    }
    if (cargosDeFactura(f).length === 0) {
      reporte.sinPaciente.push({
        invoiceId: f.id,
        uuid: f.uuid,
        receptor: f.receptorNombre ?? f.receptorRfc ?? "—",
        motivo: "el CFDI no tiene conceptos que se puedan volver cargos",
      });
      continue;
    }
    const paciente = await pacienteDe(ident, f);
    resueltas.push({
      fecha: f.fecha,
      pacienteKey: paciente.id,
      f,
      nombre: [ident.nombre, ident.apellidoPaterno, ident.apellidoMaterno].filter(Boolean).join(" "),
    });
  }

  const grupos = agruparFacturasEnEpisodios(resueltas, { diasVentana: opts.diasVentana });

  // ── 5. Un episodio (y sus cargos) por grupo, una transacción cada uno ──────
  const pagadorPorPaciente = new Map<string, Set<string | null>>();
  for (const grupo of grupos) {
    const primera = grupo[0].f;
    const ultima = grupo[grupo.length - 1].f;
    const cargos = grupo.flatMap((g) => cargosDeFactura(g.f));
    const tipo = tipoEpisodioPorConceptos(grupo.flatMap((g) => g.f.items.map((i) => i.descripcion)));
    // El receptor y el convenio del episodio salen del primer CFDI que los
    // tenga: en una estancia partida en dos, la aseguradora es la misma.
    const conReceptor = grupo.find((g) => g.f.customerId)?.f ?? primera;
    const pagador = await pagadorDe(grupo.find((g) => (g.f.receptorRfc ?? "").trim().length === 12)?.f ?? conReceptor);
    const referencias = grupo.map((g) => referenciaCfdi(g.f));
    const total = r2(cargos.reduce((s, c) => s + c.importe + (c.ivaTasa == null ? 0 : r2(c.importe * c.ivaTasa)), 0));

    const pacienteId = grupo[0].pacienteKey;
    const vistos = pagadorPorPaciente.get(pacienteId) ?? new Set<string | null>();
    vistos.add(pagador?.id ?? null);
    pagadorPorPaciente.set(pacienteId, vistos);

    reporte.episodios++;
    reporte.cargos += cargos.length;
    if (reporte.muestra.length < tope) {
      reporte.muestra.push({
        paciente: grupo[0].nombre,
        tipo,
        fechaIngreso: primera.fecha,
        fechaAlta: ultima.fecha,
        facturas: referencias,
        cargos: cargos.length,
        total,
        pagador: pagador?.nombre ?? null,
      });
    }
    if (dry) continue;

    await conReintento("alta de episodio", () =>
      conFolioUnico(() =>
        db.$transaction(async (tx) => {
          const folio = await siguienteFolio(tx, companyId, "episodio", primera.fecha);
          return tx.hospEpisodio.create({
            data: {
              companyId,
              folio,
              pacienteId,
              tipo,
              // Es historia: nace de alta, sin cama, sin médico, sin
              // documentos requeridos y sin cargos de estancia.
              estado: "ALTA",
              origen: "CFDI",
              fechaIngreso: primera.fecha,
              fechaAlta: ultima.fecha,
              pagadorId: pagador?.id ?? null,
              customerId: conReceptor.customerId,
              notasAdmin: `Reconstruido de CFDI ${referencias.join(", ")}`,
              cargos: {
                create: cargos.map((c) => ({
                  companyId,
                  fecha: c.fecha,
                  categoria: c.categoria,
                  descripcion: c.descripcion,
                  cantidad: c.cantidad,
                  precioUnitario: c.precioUnitario,
                  ivaTasa: c.ivaTasa,
                  importe: c.importe,
                  origen: "CFDI" as const,
                  invoiceId: c.invoiceId,
                })),
              },
            },
            select: { id: true },
          });
        })
      )
    );
  }
  log(`  · ${reporte.episodios} episodios · ${reporte.cargos} cargos · ${reporte.sinPaciente.length} CFDIs sin paciente`);

  // ── 6. El paciente sin convenio hereda el de sus episodios derivados ───────
  if (dry) {
    for (const [pacienteId, convenios] of pagadorPorPaciente) {
      const unico = [...convenios];
      if (unico.length !== 1 || !unico[0]) continue;
      const paciente = [...pacientes.values()].find((p) => p.id === pacienteId);
      if (paciente && !paciente.pagadorId) reporte.pacientesConPagador++;
    }
  } else {
    const conEpisodios = await conReintento("herencia de convenio", () =>
      db.hospPaciente.findMany({
        where: { companyId, pagadorId: null, episodios: { some: { origen: "CFDI", pagadorId: { not: null } } } },
        select: { id: true, episodios: { where: { origen: "CFDI" }, select: { pagadorId: true } } },
      })
    );
    for (const p of conEpisodios) {
      const convenios = new Set(p.episodios.map((e) => e.pagadorId));
      const unico = [...convenios];
      if (unico.length !== 1 || !unico[0]) continue;
      await conReintento("herencia de convenio", () => db.hospPaciente.update({ where: { id: p.id }, data: { pagadorId: unico[0] } }));
      reporte.pacientesConPagador++;
    }
  }

  return reporte;
}
