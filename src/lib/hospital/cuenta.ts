// ─────────────────────────────────────────────────────────────────────────────
// La cuenta del paciente — función PURA (docs/HOSPITAL.md → «Cuenta»).
//
// Entra la lista de cargos del episodio, el convenio y la config; sale la
// cuenta agrupada como la enseña la pantalla: tres grupos fijos, IVA por
// renglón (null = exento), totales con los honorarios separados (pasan por la
// cuenta sin ser ingreso del hospital) y el reparto entre pagador y paciente.
//
// El reparto se calcula sobre el SUBTOTAL (sin IVA), como lo hace el
// convenio en la propuesta; el IVA se expone aparte en `totales.iva`.
// Los cargos cancelados se listan (con `cancelado: true`) pero no suman.
//
// IVA de farmacia por CONTEXTO (criterio normativo 9/IVA/N, Anexo 7 RMF): la
// misma medicina grava al 16 % cuando se SUMINISTRA como parte del servicio
// hospitalario y va al 0 % (Art. 2-A LIVA) cuando se VENDE. El cargo nace con
// la tasa ya resuelta (`ivaTasa`) y guarda el porqué (`ivaContexto`); aquí
// se decide la tasa al crearlo y se parte el grupo de farmacia por contexto,
// que es como el hospital factura («FARMACIA HOSPITALARIA 16» / «… 0»).
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCargoCategoria, HospEpisodioTipo, HospIvaContexto, HospPagadorTipo } from "@prisma/client";
import { r2 } from "./util";

export interface CargoCuenta {
  id: string;
  fecha: Date | string;
  descripcion: string;
  categoria: HospCargoCategoria;
  cantidad: number;
  precioUnitario: number;
  ivaTasa: number | null;
  /** cantidad × precio sin IVA. Si falta se calcula. */
  importe?: number | null;
  origen: string;
  cancelado: boolean;
  invoiceId?: string | null;
  servicioId?: string | null;
  loteId?: string | null;
  medicoId?: string | null;
  motivoCancelacion?: string | null;
  lote?: { lote: string } | string | null;
  medico?: { id: string; nombre: string } | null;
  /** Sólo farmacia/material: por qué lleva la tasa que lleva. */
  ivaContexto?: HospIvaContexto | null;
}

export interface PagadorCuenta {
  id?: string;
  nombre: string;
  tipo: HospPagadorTipo;
  deducible: number | null;
  coaseguroPct: number | null;
  plazoDias: number;
  topeAutorizacion: number | null;
}

export interface ConfigCuenta {
  topeAutorizacion?: number | null;
}

export interface RenglonCuenta {
  id: string;
  fecha: Date | string;
  descripcion: string;
  categoria: HospCargoCategoria;
  cantidad: number;
  precioUnitario: number;
  ivaTasa: number | null;
  importe: number;
  iva: number;
  total: number;
  origen: string;
  lote: string | null;
  medico: { id: string; nombre: string } | null;
  invoiceId: string | null;
  cancelado: boolean;
  motivoCancelacion: string | null;
  ivaContexto: HospIvaContexto | null;
}

export interface TotalesCuenta {
  subtotal: number;
  iva: number;
  total: number;
}

/** Llaves del corte de farmacia por contexto de IVA (los viejos sin contexto aparte). */
export type LlaveIvaContexto = HospIvaContexto | "SIN_CONTEXTO";

export interface GrupoCuenta {
  categoria: HospCargoCategoria;
  categorias: HospCargoCategoria[];
  titulo: string;
  cargos: RenglonCuenta[];
  subtotal: number;
  iva: number;
  total: number;
  /** Sólo en el grupo de farmacia: lo que va a «FARMACIA HOSPITALARIA 16» y a «… 0». */
  porIvaContexto?: Record<LlaveIvaContexto, TotalesCuenta>;
}

export interface Cuenta {
  grupos: GrupoCuenta[];
  totales: { subtotal: number; iva: number; total: number; honorarios: number; hospital: number };
  reparto: {
    pagador: PagadorCuenta | null;
    base: number;
    deducible: number;
    coaseguro: number;
    paciente: number;
    aseguradora: number;
    requiereAutorizacion: boolean;
    topeAutorizacion: number | null;
  };
}

export const GRUPOS_CUENTA: ReadonlyArray<{
  categoria: HospCargoCategoria;
  titulo: string;
  categorias: HospCargoCategoria[];
}> = [
  { categoria: "HABITACION", titulo: "Hospitalización y quirófano", categorias: ["HABITACION", "QUIROFANO", "URGENCIAS"] },
  { categoria: "FARMACIA", titulo: "Farmacia y material · sale con su lote", categorias: ["FARMACIA", "MATERIAL", "EQUIPO"] },
  { categoria: "ESTUDIO", titulo: "Estudios y honorarios", categorias: ["ESTUDIO", "PROCEDIMIENTO", "HONORARIO", "OTRO"] },
];

/** IVA de medicinas en hospitalización cuando la empresa no fijó el suyo. */
export const IVA_MEDICINAS_HOSPITALIZACION_DEFAULT = 0.16;

/**
 * Contexto de IVA con el que nace un cargo de farmacia según el episodio: en
 * hospitalización, cirugía ambulatoria y urgencias el medicamento se
 * suministra como parte de la atención; en consulta externa se vende.
 */
export function ivaContextoPorEpisodio(tipo: HospEpisodioTipo): HospIvaContexto {
  return tipo === "CONSULTA" ? "VENTA_DIRECTA" : "SUMINISTRO_HOSPITALARIO";
}

/**
 * Tasa de IVA de un cargo de farmacia/material según el contexto:
 *   · SUMINISTRO_HOSPITALARIO → medicinas y soluciones (categoría FARMACIA)
 *     toman `HospConfig.ivaMedicinasHospitalizacion` (16 % por default; el
 *     contador puede fijar 0 si sigue el criterio de PRODECON);
 *   · VENTA_DIRECTA → la tasa del insumo (0 % en medicinas de patente).
 * El material de curación, el equipo y los reactivos gravan igual en los dos
 * contextos (no son «medicinas de patente»): conservan la tasa del insumo.
 */
export function ivaTasaPorContexto(args: {
  contexto: HospIvaContexto;
  categoria: HospCargoCategoria;
  ivaTasaInsumo: number | null;
  ivaMedicinasHospitalizacion?: number | null;
}): number | null {
  if (args.categoria !== "FARMACIA") return args.ivaTasaInsumo;
  if (args.contexto === "VENTA_DIRECTA") return args.ivaTasaInsumo;
  return args.ivaMedicinasHospitalizacion ?? IVA_MEDICINAS_HOSPITALIZACION_DEFAULT;
}

/** Importe, IVA y total de un cargo (sin IVA cuando la tasa es null = exento). */
export function calcularRenglon(c: CargoCuenta): RenglonCuenta {
  const importe = r2(c.importe != null ? Number(c.importe) : Number(c.cantidad) * Number(c.precioUnitario));
  const iva = c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa));
  return {
    id: c.id,
    fecha: c.fecha,
    descripcion: c.descripcion,
    categoria: c.categoria,
    cantidad: Number(c.cantidad),
    precioUnitario: Number(c.precioUnitario),
    ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa),
    importe,
    iva,
    total: r2(importe + iva),
    origen: c.origen,
    lote: typeof c.lote === "string" ? c.lote : (c.lote?.lote ?? null),
    medico: c.medico ?? null,
    invoiceId: c.invoiceId ?? null,
    cancelado: c.cancelado,
    motivoCancelacion: c.motivoCancelacion ?? null,
    ivaContexto: c.ivaContexto ?? null,
  };
}

function sumarTotales(renglones: RenglonCuenta[]): TotalesCuenta {
  const subtotal = r2(renglones.reduce((s, r) => s + r.importe, 0));
  const iva = r2(renglones.reduce((s, r) => s + r.iva, 0));
  return { subtotal, iva, total: r2(subtotal + iva) };
}

/** Corte de los renglones vivos por contexto de IVA (farmacia). */
export function totalesPorIvaContexto(vivos: RenglonCuenta[]): Record<LlaveIvaContexto, TotalesCuenta> {
  const de = (llave: LlaveIvaContexto) =>
    sumarTotales(vivos.filter((r) => (r.ivaContexto ?? "SIN_CONTEXTO") === llave));
  return {
    SUMINISTRO_HOSPITALARIO: de("SUMINISTRO_HOSPITALARIO"),
    VENTA_DIRECTA: de("VENTA_DIRECTA"),
    SIN_CONTEXTO: de("SIN_CONTEXTO"),
  };
}

/**
 * Reparto del convenio sobre `base`: el paciente absorbe el deducible y el
 * coaseguro del resto; el pagador, lo demás. Sin convenio o PARTICULAR, todo
 * al paciente. `requiereAutorizacion` cuando la base rebasa el tope del
 * convenio (o el default de la empresa).
 */
export function calcularReparto(base: number, pagador: PagadorCuenta | null, config?: ConfigCuenta | null): Cuenta["reparto"] {
  const tope = pagador?.topeAutorizacion ?? config?.topeAutorizacion ?? null;
  const requiereAutorizacion = tope != null && base > Number(tope);

  if (!pagador || pagador.tipo === "PARTICULAR") {
    return {
      pagador,
      base,
      deducible: 0,
      coaseguro: 0,
      paciente: base,
      aseguradora: 0,
      requiereAutorizacion,
      topeAutorizacion: tope == null ? null : Number(tope),
    };
  }
  const deducible = r2(Math.min(base, Number(pagador.deducible ?? 0)));
  const coaseguro = r2(Number(pagador.coaseguroPct ?? 0) * (base - deducible));
  const paciente = r2(deducible + coaseguro);
  return {
    pagador,
    base,
    deducible,
    coaseguro,
    paciente,
    aseguradora: r2(base - paciente),
    requiereAutorizacion,
    topeAutorizacion: tope == null ? null : Number(tope),
  };
}

export function calcularCuenta(args: {
  cargos: CargoCuenta[];
  pagador?: PagadorCuenta | null;
  config?: ConfigCuenta | null;
}): Cuenta {
  const pagador = args.pagador ?? null;
  const renglones = args.cargos.map(calcularRenglon);

  const grupos: GrupoCuenta[] = GRUPOS_CUENTA.map((g) => {
    const cargos = renglones.filter((r) => g.categorias.includes(r.categoria));
    const vivos = cargos.filter((r) => !r.cancelado);
    const { subtotal, iva, total } = sumarTotales(vivos);
    const grupo: GrupoCuenta = { categoria: g.categoria, categorias: [...g.categorias], titulo: g.titulo, cargos, subtotal, iva, total };
    if (g.categoria === "FARMACIA") grupo.porIvaContexto = totalesPorIvaContexto(vivos);
    return grupo;
  });

  const vivos = renglones.filter((r) => !r.cancelado);
  const { subtotal, iva, total } = sumarTotales(vivos);
  // Los honorarios (con su IVA, normalmente exento) van y vienen por la cuenta
  // sin ser ingreso del hospital: se separan para que el resultado no mienta.
  const honorarios = r2(vivos.filter((r) => r.categoria === "HONORARIO").reduce((s, r) => s + r.total, 0));

  return {
    grupos,
    totales: { subtotal, iva, total, honorarios, hospital: r2(total - honorarios) },
    reparto: calcularReparto(subtotal, pagador, args.config),
  };
}
