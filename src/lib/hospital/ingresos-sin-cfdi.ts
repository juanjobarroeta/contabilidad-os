// ─────────────────────────────────────────────────────────────────────────────
// INGRESOS SIN CFDI DEL MES — lo que caja cobró sin comprobante propio.
//
// Un cobro SIN_CFDI se declara igual: el ISR de la persona moral lo acumula al
// cobrarse (Art. 17 LISR) y el IVA se causa al cobrarse (Art. 1-B LIVA). Su
// comprobante es la factura global a público en general; mientras ésta no se
// timbre, el SAT no lo ve en su precargado y el contador lo captura como
// «INGRESOS NOMINALES ADICIONALES» (así lo hizo con 22,597 en agosto 2026).
// Este módulo calcula esa cifra para que el motor la sume sola.
//
// Cubierto = ya tiene CFDI timbrado: el cobro trae una factura vigente, o los
// cargos que mandó a la global ya están en una global timbrada (si sólo una
// parte, se cubre en esa proporción). Lo cubierto ya viene en los CFDIs del
// mes y no se vuelve a sumar.
//
// Tasa de IVA: la ponderada de los cargos del episodio (por importe); sin
// cargos con tasa, la de `HospConfig.ivaAnticiposTasa`; si tampoco, 0. El
// cobro es lo pagado CON IVA: base = monto / (1 + tasa), IVA = monto − base.
//
// Sólo cobros vigentes (COBRADO, DEPOSITADO, RECUPERADO): un cancelado no se
// cobró y un contracargado se devolvió.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCobroEstado, Prisma, PrismaClient } from "@prisma/client";
import { r2 } from "./util";

// Los de cobros.ts (ESTADOS_VIGENTES). Se repiten aquí para que el motor
// fiscal no arrastre la capa contable del hospital (asientos) al importarlo.
const VIGENTES: HospCobroEstado[] = ["COBRADO", "DEPOSITADO", "RECUPERADO"];

type Db = PrismaClient | Prisma.TransactionClient;

export interface CargoParaTasa {
  importe: number;
  ivaTasa: number | null;
}

/** Tasa ponderada por importe de los cargos con tasa conocida; null si ninguno la trae. */
export function tasaPonderada(cargos: CargoParaTasa[]): number | null {
  const conTasa = cargos.filter((c) => c.ivaTasa != null && c.importe > 0);
  const total = conTasa.reduce((s, c) => s + c.importe, 0);
  if (total <= 0) return null;
  return conTasa.reduce((s, c) => s + c.importe * (c.ivaTasa as number), 0) / total;
}

/** Parte un cobro (con IVA) en base e IVA. */
export function desglosarCobro(monto: number, tasa: number): { base: number; iva: number } {
  const base = r2(monto / (1 + Math.max(0, tasa)));
  return { base, iva: r2(monto - base) };
}

export interface CobroSinCfdi {
  id: string;
  monto: number;
  /** Para el papel de trabajo: cuándo y de quién. */
  fecha?: Date;
  etiqueta?: string | null;
  /** Factura vigente del cobro (timbrada): lo cubre entero. */
  facturaVigente: boolean;
  /** Cargos que el cobro mandó a la global: importe total y el ya timbrado. */
  cargosGlobal: { importe: number; timbrado: boolean }[];
  /** Cargos del episodio, para la tasa. */
  cargosEpisodio: CargoParaTasa[];
}

/** Lo que de un cobro sigue sin CFDI timbrado, de 0 a monto. */
export function montoNoCubierto(c: CobroSinCfdi): number {
  if (c.facturaVigente) return 0;
  const total = c.cargosGlobal.reduce((s, x) => s + x.importe, 0);
  if (total <= 0) return c.monto;
  const timbrado = c.cargosGlobal.filter((x) => x.timbrado).reduce((s, x) => s + x.importe, 0);
  return r2(c.monto * (1 - Math.min(1, timbrado / total)));
}

export interface IngresosSinCfdi {
  /** Base (sin IVA): va a ingresos nominales adicionales del ISR. */
  base: number;
  /** IVA trasladado causado al cobro. */
  iva: number;
  cobros: number;
  detalle: { cobroId: string; fecha: Date | null; etiqueta: string | null; noCubierto: number; tasa: number; base: number; iva: number }[];
}

export function sumarIngresosSinCfdi(cobros: CobroSinCfdi[], tasaDefault: number | null): IngresosSinCfdi {
  const out: IngresosSinCfdi = { base: 0, iva: 0, cobros: 0, detalle: [] };
  for (const c of cobros) {
    const noCubierto = montoNoCubierto(c);
    if (noCubierto <= 0.005) continue;
    const tasa = tasaPonderada(c.cargosEpisodio) ?? tasaDefault ?? 0;
    const { base, iva } = desglosarCobro(noCubierto, tasa);
    out.base += base;
    out.iva += iva;
    out.cobros += 1;
    out.detalle.push({ cobroId: c.id, fecha: c.fecha ?? null, etiqueta: c.etiqueta ?? null, noCubierto, tasa, base, iva });
  }
  out.base = r2(out.base);
  out.iva = r2(out.iva);
  return out;
}

/** Los cobros SIN_CFDI vigentes de [desde, hasta) con lo necesario para saber qué falta timbrar. */
export async function ingresosSinCfdiEnRango(db: Db, companyId: string, desde: Date, hasta: Date): Promise<IngresosSinCfdi> {
  const filas = await db.hospCobro.findMany({
    where: { companyId, cfdi: "SIN_CFDI", estado: { in: VIGENTES }, fecha: { gte: desde, lt: hasta } },
    select: {
      id: true,
      monto: true,
      fecha: true,
      invoice: { select: { status: true } },
      episodio: {
        select: {
          folio: true,
          paciente: { select: { nombre: true, apellidoPaterno: true } },
          cargos: {
            where: { cancelado: false },
            select: { importe: true, ivaTasa: true, publicoGeneralCobroId: true, invoice: { select: { status: true } } },
          },
        },
      },
    },
  });
  if (filas.length === 0) return { base: 0, iva: 0, cobros: 0, detalle: [] };
  const config = await db.hospConfig.findUnique({ where: { companyId }, select: { ivaAnticiposTasa: true } });
  const tasaDefault = config?.ivaAnticiposTasa == null ? null : Number(config.ivaAnticiposTasa);

  const cobros: CobroSinCfdi[] = filas.map((f) => {
    const cargos = f.episodio?.cargos ?? [];
    const pac = f.episodio?.paciente;
    return {
      id: f.id,
      monto: Number(f.monto),
      fecha: f.fecha,
      etiqueta: f.episodio ? [f.episodio.folio, pac && `${pac.nombre} ${pac.apellidoPaterno}`].filter(Boolean).join(" · ") : null,
      facturaVigente: f.invoice?.status === "STAMPED",
      cargosGlobal: cargos
        .filter((c) => c.publicoGeneralCobroId === f.id)
        .map((c) => ({ importe: Number(c.importe), timbrado: c.invoice?.status === "STAMPED" })),
      cargosEpisodio: cargos.map((c) => ({ importe: Number(c.importe), ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa) })),
    };
  });
  return sumarIngresosSinCfdi(cobros, tasaDefault);
}
