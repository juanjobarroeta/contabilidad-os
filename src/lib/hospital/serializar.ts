// Resúmenes que repiten las rutas del módulo: la misma forma de paciente,
// médico, pagador, receptor y cama en listados, expediente, censo y cuenta,
// con los Decimal ya como número.

import type { HospCargoCategoria, HospIvaContexto, HospPagadorTipo, HospRecursoEstado, HospRecursoTipo, HospArea, HospSexo } from "@prisma/client";
import type { CargoCuenta } from "./cuenta";
import { edad, nombreCompleto, r2 } from "./util";

export function pacienteResumen(
  p: {
    id: string;
    nombre: string;
    apellidoPaterno: string;
    apellidoMaterno?: string | null;
    fechaNacimiento?: Date | null;
    sexo?: HospSexo | null;
    telefono?: string | null;
    curp?: string | null;
  },
  hoy: Date = new Date()
) {
  return {
    id: p.id,
    nombre: p.nombre,
    apellidoPaterno: p.apellidoPaterno,
    apellidoMaterno: p.apellidoMaterno ?? null,
    nombreCompleto: nombreCompleto(p),
    edad: edad(p.fechaNacimiento, hoy),
    sexo: p.sexo ?? null,
    fechaNacimiento: p.fechaNacimiento ?? null,
    telefono: p.telefono ?? null,
    curp: p.curp ?? null,
  };
}

export function medicoResumen(m: { id: string; nombre: string; especialidad?: string | null } | null | undefined) {
  return m ? { id: m.id, nombre: m.nombre, especialidad: m.especialidad ?? null } : null;
}

export function pagadorResumen(
  p:
    | {
        id: string;
        nombre: string;
        tipo: HospPagadorTipo;
        tabulador?: string | null;
        deducible?: unknown;
        coaseguroPct?: unknown;
        plazoDias?: number;
        topeAutorizacion?: unknown;
      }
    | null
    | undefined
) {
  if (!p) return null;
  return {
    id: p.id,
    nombre: p.nombre,
    tipo: p.tipo,
    tabulador: p.tabulador ?? null,
    deducible: p.deducible == null ? null : Number(p.deducible),
    coaseguroPct: p.coaseguroPct == null ? null : Number(p.coaseguroPct),
    plazoDias: p.plazoDias ?? 0,
    topeAutorizacion: p.topeAutorizacion == null ? null : Number(p.topeAutorizacion),
  };
}

export function customerResumen(c: { id: string; razonSocial: string; rfc: string } | null | undefined) {
  return c ? { id: c.id, razonSocial: c.razonSocial, rfc: c.rfc } : null;
}

export function recursoResumen(
  r: { id: string; tipo: HospRecursoTipo; area: HospArea; nombre: string; estado: HospRecursoEstado } | null | undefined
) {
  return r ? { id: r.id, tipo: r.tipo, area: r.area, nombre: r.nombre, estado: r.estado } : null;
}

/** Fila de HospCargo (con lote/medico incluidos o no) → entrada de calcularCuenta. */
export function cargoParaCuenta(c: {
  id: string;
  fecha: Date;
  descripcion: string;
  categoria: HospCargoCategoria;
  cantidad: unknown;
  precioUnitario: unknown;
  ivaTasa: unknown;
  importe: unknown;
  origen: string;
  cancelado: boolean;
  motivoCancelacion?: string | null;
  invoiceId?: string | null;
  servicioId?: string | null;
  loteId?: string | null;
  medicoId?: string | null;
  lote?: { lote: string } | null;
  medico?: { id: string; nombre: string } | null;
  ivaContexto?: HospIvaContexto | null;
}): CargoCuenta {
  return {
    id: c.id,
    fecha: c.fecha,
    descripcion: c.descripcion,
    categoria: c.categoria,
    cantidad: Number(c.cantidad),
    precioUnitario: Number(c.precioUnitario),
    ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa),
    importe: Number(c.importe),
    origen: c.origen,
    cancelado: c.cancelado,
    motivoCancelacion: c.motivoCancelacion ?? null,
    invoiceId: c.invoiceId ?? null,
    servicioId: c.servicioId ?? null,
    loteId: c.loteId ?? null,
    medicoId: c.medicoId ?? null,
    lote: c.lote ?? null,
    medico: c.medico ?? null,
    ivaContexto: c.ivaContexto ?? null,
  };
}

/** Subtotal/IVA/total de un conjunto de cargos vivos (los cancelados no suman). */
export function totalesCargos(cargos: Array<{ importe: unknown; ivaTasa: unknown; cancelado: boolean }>) {
  let subtotal = 0;
  let iva = 0;
  for (const c of cargos) {
    if (c.cancelado) continue;
    const importe = Number(c.importe);
    subtotal += importe;
    if (c.ivaTasa != null) iva += r2(importe * Number(c.ivaTasa));
  }
  subtotal = r2(subtotal);
  iva = r2(iva);
  return { subtotal, iva, total: r2(subtotal + iva) };
}
