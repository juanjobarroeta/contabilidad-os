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
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCargoCategoria, HospPagadorTipo } from "@prisma/client";
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
}

export interface GrupoCuenta {
  categoria: HospCargoCategoria;
  categorias: HospCargoCategoria[];
  titulo: string;
  cargos: RenglonCuenta[];
  subtotal: number;
  iva: number;
  total: number;
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
    const subtotal = r2(vivos.reduce((s, r) => s + r.importe, 0));
    const iva = r2(vivos.reduce((s, r) => s + r.iva, 0));
    return { categoria: g.categoria, categorias: [...g.categorias], titulo: g.titulo, cargos, subtotal, iva, total: r2(subtotal + iva) };
  });

  const vivos = renglones.filter((r) => !r.cancelado);
  const subtotal = r2(vivos.reduce((s, r) => s + r.importe, 0));
  const iva = r2(vivos.reduce((s, r) => s + r.iva, 0));
  const total = r2(subtotal + iva);
  // Los honorarios (con su IVA, normalmente exento) van y vienen por la cuenta
  // sin ser ingreso del hospital: se separan para que el resultado no mienta.
  const honorarios = r2(vivos.filter((r) => r.categoria === "HONORARIO").reduce((s, r) => s + r.total, 0));

  return {
    grupos,
    totales: { subtotal, iva, total, honorarios, hospital: r2(total - honorarios) },
    reparto: calcularReparto(subtotal, pagador, args.config),
  };
}
