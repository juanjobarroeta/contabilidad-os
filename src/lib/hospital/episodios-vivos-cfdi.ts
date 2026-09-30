// ─────────────────────────────────────────────────────────────────────────────
// La factura de un episodio VIVO: ligar sus cargos al CFDI que los cobró.
//
// `HospCargo.invoiceId` sólo lo escribía la reconstrucción histórica
// (episodios-cfdi.ts), que CREA episodios a partir de CFDIs sin cargos. Un
// episodio capturado en piso y facturado fuera del módulo (la emisión desde el
// módulo es la fase 2) se quedaba con sus cargos sueltos: el CFDI caía entero a
// «otros ingresos» —honorarios incluidos, que son del médico— y la retención
// del alta cargaba un 205.06 que ninguna factura había abonado. Peor: la
// reconstrucción histórica, si corría, le fabricaba a ese CFDI un episodio
// duplicado.
//
// Aquí se liga, sin crear nada:
//   · Candidatos: CFDIs de ingreso vigentes que no amparan cargos, del cliente
//     del episodio, de su paciente o de su pagador.
//   · Ventana: desde 3 días antes del ingreso hasta 30 después del alta (o de
//     hoy, si sigue abierto): un hospital factura al alta o poco después.
//   · Monto: el total del CFDI contra lo que suman los cargos sueltos con su
//     IVA. Primero la cuenta completa; si no, el prefijo cronológico (una
//     estancia larga se factura en exhibiciones). Tolerancia: el mayor de $1 y
//     0.5 %. Un CFDI de puro anticipo nunca liga cargos.
//   · Ambigüedad: si más de un episodio empata, no se adivina — queda en
//     pendientes con el porqué. Tampoco se parte un episodio entre dos
//     facturas de pagadores distintos (aseguradora + coaseguro): los cargos
//     llevan UNA factura, y ése lo asigna una persona.
// Idempotente: sólo mira cargos con invoiceId null y CFDIs sin cargos.
//
// Y el depósito del paciente con su CFDI de anticipo: mismo receptor, total a
// ±$1 del monto, a ±7 días. Sin él el depósito es IVA causado sin comprobante
// (Art. 1-B LIVA) y aparece en los pendientes, más grave mientras más viejo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDepositoEstado, Prisma, PrismaClient } from "@prisma/client";
import { diasDesde, severidadAnticipo, type SeveridadAnticipo } from "@/lib/bancos/anticipos";
import { normalizarDescripcion } from "./cfdi-texto";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;
const DIA = 86_400_000;

export const DIAS_ANTES_INGRESO = 3;
export const DIAS_DESPUES_ALTA = 30;
export const DIAS_ANTICIPO = 7;

// ─── Puro ────────────────────────────────────────────────────────────────────

export interface CargoSuelto {
  id: string;
  fecha: Date;
  importe: number;
  ivaTasa: number | null;
}

export interface EpisodioVivo {
  id: string;
  folio: string;
  fechaIngreso: Date;
  fechaAlta: Date | null;
  cargos: CargoSuelto[];
}

export const conIva = (c: CargoSuelto) => r2(c.importe * (1 + (c.ivaTasa ?? 0)));
export const tolerancia = (total: number) => Math.max(1, Math.abs(total) * 0.005);

/** Los cargos que ampara un CFDI de `total`: la cuenta completa o su prefijo cronológico. */
export function cargosQueAmpara(total: number, cargos: CargoSuelto[]): string[] | null {
  if (cargos.length === 0 || !(total > 0)) return null;
  const orden = [...cargos].sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.id.localeCompare(b.id));
  const tol = tolerancia(total);
  let suma = 0;
  for (let i = 0; i < orden.length; i++) {
    suma = r2(suma + conIva(orden[i]));
    if (Math.abs(suma - total) <= tol) {
      // Sólo cierra aquí si el siguiente cargo no lo acerca más (cargos en cero).
      let fin = i;
      while (fin + 1 < orden.length && conIva(orden[fin + 1]) === 0) fin++;
      return orden.slice(0, fin + 1).map((c) => c.id);
    }
    if (suma - total > tol) break;
  }
  return null;
}

/** ¿La fecha del CFDI cae en la ventana del episodio? */
export function enVentana(fecha: Date, e: { fechaIngreso: Date; fechaAlta: Date | null }, hoy: Date = new Date()): boolean {
  const desde = e.fechaIngreso.getTime() - DIAS_ANTES_INGRESO * DIA;
  const hasta = (e.fechaAlta ?? hoy).getTime() + DIAS_DESPUES_ALTA * DIA;
  return fecha.getTime() >= desde && fecha.getTime() <= hasta;
}

export type Emparejamiento =
  | { episodioId: string; cargoIds: string[] }
  | { episodioId: null; motivo: string; candidatos: string[] };

/** A qué episodio (y a qué cargos) corresponde un CFDI, o por qué no se sabe. */
export function emparejarCfdi(f: { total: number; fecha: Date }, episodios: EpisodioVivo[], hoy: Date = new Date()): Emparejamiento {
  const enFecha = episodios.filter((e) => e.cargos.length > 0 && enVentana(f.fecha, e, hoy));
  if (enFecha.length === 0) return { episodioId: null, motivo: "ningún episodio del receptor con cargos sueltos en la ventana de fechas", candidatos: [] };
  const empatan = enFecha
    .map((e) => ({ e, ids: cargosQueAmpara(f.total, e.cargos) }))
    .filter((x): x is { e: EpisodioVivo; ids: string[] } => !!x.ids);
  if (empatan.length === 1) return { episodioId: empatan[0].e.id, cargoIds: empatan[0].ids };
  if (empatan.length > 1) return { episodioId: null, motivo: "empata con más de un episodio", candidatos: empatan.map((x) => x.e.folio) };
  return {
    episodioId: null,
    motivo: "el total no cuadra con los cargos sueltos (¿factura parcial, reparto con pagador o descuento?)",
    candidatos: enFecha.map((e) => e.folio),
  };
}

const RE_ANTICIPO = /^(ANTICIPO|APLICACION DE ANTICIPO)/;
/** ¿El CFDI es de anticipo? Clave 84111506 o todos los conceptos «Anticipo…». */
export function esCfdiDeAnticipo(items: Array<{ claveProdServ?: string | null; descripcion: string | null }>): boolean {
  if (items.length === 0) return false;
  return items.every((i) => i.claveProdServ === "84111506" || RE_ANTICIPO.test(normalizarDescripcion(i.descripcion)));
}

// ─── Base de datos ───────────────────────────────────────────────────────────

export interface VinculoCfdi {
  invoiceId: string;
  referencia: string;
  episodioId: string;
  folio: string;
  cargos: number;
  total: number;
}

export interface CfdiPendiente {
  invoiceId: string;
  referencia: string;
  fecha: Date;
  total: number;
  receptor: string | null;
  motivo: string;
  candidatos: string[];
}

export interface EpisodioSinCfdi {
  episodioId: string;
  folio: string;
  fechaAlta: Date | null;
  cargosSueltos: number;
  totalSuelto: number;
}

export interface DepositoPendiente {
  depositoId: string;
  folio: string;
  fecha: Date;
  monto: number;
  estado: HospDepositoEstado;
  dias: number;
  severidad: SeveridadAnticipo;
}

export interface ReporteVinculos {
  vinculados: VinculoCfdi[];
  depositosLigados: number;
  cfdisPendientes: CfdiPendiente[];
  episodiosSinCfdi: EpisodioSinCfdi[];
  depositosSinAnticipo: DepositoPendiente[];
}

const referencia = (f: { serie: string | null; folio: string | null; uuid: string | null; id: string }) =>
  [f.serie?.trim(), f.folio?.trim()].filter(Boolean).join("-") || f.uuid?.slice(0, 8).toUpperCase() || f.id;

/**
 * Liga cargos de episodios vivos con su CFDI, y depósitos con su CFDI de
 * anticipo. `dry` no escribe: devuelve el mismo reporte (lo usa la API de
 * pendientes). `desde`: qué tan atrás mirar CFDIs (default 180 días).
 */
export async function vincularCfdisVivos(
  db: Db,
  companyId: string,
  opts: { dry?: boolean; desde?: Date; hoy?: Date } = {},
): Promise<ReporteVinculos> {
  const hoy = opts.hoy ?? new Date();
  const desde = opts.desde ?? new Date(hoy.getTime() - 180 * DIA);
  const reporte: ReporteVinculos = { vinculados: [], depositosLigados: 0, cfdisPendientes: [], episodiosSinCfdi: [], depositosSinAnticipo: [] };

  // Episodios capturados (no los reconstruidos de CFDIs), con cargos sueltos.
  const episodios = await db.hospEpisodio.findMany({
    where: {
      companyId,
      origen: { not: "CFDI" },
      estado: { not: "CANCELADO" },
      fechaIngreso: { gte: new Date(desde.getTime() - 60 * DIA) },
    },
    select: {
      id: true,
      folio: true,
      fechaIngreso: true,
      fechaAlta: true,
      estado: true,
      customerId: true,
      paciente: { select: { customerId: true } },
      pagador: { select: { customerId: true } },
      cargos: { where: { invoiceId: null, cancelado: false }, select: { id: true, fecha: true, importe: true, ivaTasa: true } },
      depositos: { where: { estado: { not: "CANCELADO" }, invoiceAnticipoId: null }, select: { id: true, fecha: true, monto: true, estado: true, aplicadoAt: true } },
    },
  });
  const porCliente = new Map<string, EpisodioVivo[]>();
  const vivos = new Map<string, EpisodioVivo>();
  for (const e of episodios) {
    const vivo: EpisodioVivo = {
      id: e.id,
      folio: e.folio,
      fechaIngreso: e.fechaIngreso,
      fechaAlta: e.fechaAlta,
      cargos: e.cargos.map((c) => ({ id: c.id, fecha: c.fecha, importe: Number(c.importe), ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa) })),
    };
    vivos.set(e.id, vivo);
    for (const cid of new Set([e.customerId, e.paciente?.customerId, e.pagador?.customerId].filter((x): x is string => !!x))) {
      porCliente.set(cid, [...(porCliente.get(cid) ?? []), vivo]);
    }
  }
  if (porCliente.size === 0) return reporte;

  const facturas = await db.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      status: { not: "CANCELLED" },
      OR: [{ tipoSat: "I" }, { tipoSat: null }],
      hospCargos: { none: {} },
      hospDepositosAnticipo: { none: {} },
      customerId: { in: [...porCliente.keys()] },
      fecha: { gte: desde },
    },
    select: {
      id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, customerId: true,
      customer: { select: { razonSocial: true } },
      items: { select: { claveProdServ: true, descripcion: true } },
    },
    orderBy: { fecha: "asc" },
  });

  // ── Depósitos ↔ CFDI de anticipo ────────────────────────────────────────
  const anticipos = facturas.filter((f) => esCfdiDeAnticipo(f.items));
  const usadas = new Set<string>();
  for (const e of episodios) {
    const clientes = new Set([e.customerId, e.paciente?.customerId, e.pagador?.customerId].filter(Boolean));
    for (const d of e.depositos) {
      const monto = Number(d.monto);
      const cfdi = anticipos.find(
        (f) => !usadas.has(f.id) && clientes.has(f.customerId) && Math.abs(Number(f.total) - monto) <= 1 && Math.abs(f.fecha.getTime() - d.fecha.getTime()) <= DIAS_ANTICIPO * DIA,
      );
      if (cfdi) {
        usadas.add(cfdi.id);
        reporte.depositosLigados++;
        if (!opts.dry) await db.hospDeposito.updateMany({ where: { id: d.id, invoiceAnticipoId: null }, data: { invoiceAnticipoId: cfdi.id } });
        continue;
      }
      // Sin CFDI de anticipo: pendiente mientras siga recibido, o si se aplicó
      // en un mes posterior al del cobro (el IVA ya se había causado).
      const mesDe = (x: Date) => x.getUTCFullYear() * 12 + x.getUTCMonth();
      const aplicadoOtroMes = d.estado === "APLICADO" && d.aplicadoAt && mesDe(d.aplicadoAt) !== mesDe(d.fecha);
      if (d.estado === "RECIBIDO" || aplicadoOtroMes) {
        const dias = diasDesde(d.fecha, hoy);
        reporte.depositosSinAnticipo.push({ depositoId: d.id, folio: e.folio, fecha: d.fecha, monto: r2(monto), estado: d.estado, dias, severidad: severidadAnticipo(dias) });
      }
    }
  }

  // ── Cargos ↔ CFDI del servicio ──────────────────────────────────────────
  for (const f of facturas) {
    if (usadas.has(f.id) || esCfdiDeAnticipo(f.items)) continue;
    const candidatos = f.customerId ? porCliente.get(f.customerId) ?? [] : [];
    const r = emparejarCfdi({ total: Number(f.total), fecha: f.fecha }, candidatos, hoy);
    if (r.episodioId === null) {
      reporte.cfdisPendientes.push({ invoiceId: f.id, referencia: referencia(f), fecha: f.fecha, total: r2(Number(f.total)), receptor: f.customer?.razonSocial ?? null, motivo: r.motivo, candidatos: r.candidatos });
      continue;
    }
    if (!opts.dry) {
      await db.hospCargo.updateMany({ where: { id: { in: r.cargoIds }, invoiceId: null }, data: { invoiceId: f.id } });
    }
    const vivo = vivos.get(r.episodioId)!;
    const ligados = new Set(r.cargoIds);
    vivo.cargos = vivo.cargos.filter((c) => !ligados.has(c.id));
    reporte.vinculados.push({ invoiceId: f.id, referencia: referencia(f), episodioId: vivo.id, folio: vivo.folio, cargos: r.cargoIds.length, total: r2(Number(f.total)) });
  }

  // ── Episodios dados de alta hace más de 7 días con cargos sin factura ──
  for (const e of episodios) {
    const vivo = vivos.get(e.id)!;
    if (e.estado !== "ALTA" || !e.fechaAlta || hoy.getTime() - e.fechaAlta.getTime() < 7 * DIA || vivo.cargos.length === 0) continue;
    reporte.episodiosSinCfdi.push({
      episodioId: e.id,
      folio: e.folio,
      fechaAlta: e.fechaAlta,
      cargosSueltos: vivo.cargos.length,
      totalSuelto: r2(vivo.cargos.reduce((s, c) => s + conIva(c), 0)),
    });
  }
  reporte.depositosSinAnticipo.sort((a, b) => b.dias - a.dias);
  return reporte;
}

/** Empresas con el módulo hospital configurado. */
export async function empresasHospital(db: Db): Promise<string[]> {
  return (await db.hospConfig.findMany({ select: { companyId: true } })).map((c) => c.companyId);
}
