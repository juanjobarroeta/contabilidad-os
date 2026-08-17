// ─────────────────────────────────────────────────────────────────────────────
// Fase 1 del motor al plan PROPIO (docs/PLAN-motor-plan-propio.md).
//
// El motor emite códigos agrupador ("601.48", "105", "115.04"). La empresa,
// desde su CT, declara el agrupador de cada cuenta PROPIA (ChartAccount.codAgrup,
// Fase 0). Este resolver invierte esa relación:
//
//   1. Override explícito (PostingCuentaOverride) — el contador decidió.
//   2. Inversión sin ambigüedad: EXACTAMENTE una cuenta propia activa con ese
//      codAgrup → ésa.
//   3. Varias candidatas o ninguna → null, y resolveAccount cae al stub
//      agrupador de siempre. Adopción gradual, cero big-bang: un código no
//      mapeado postea HOY igual que ayer.
//
// La ambigüedad es real y esperada: los agrupadores de gasto existen por
// DEPARTAMENTO (6100/6300/6400/6600/6700 comparten plantilla), y las familias
// de inventario comparten 115.04. Ésas se resuelven con override (contador,
// una vez) o con la resolución por módulo de la Fase 2 (familia del vehículo).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import type { ChartAccount } from "@prisma/client";

/**
 * La cuenta PROPIA para un código del motor, o null si no hay resolución
 * segura (sin datos, o ambigua sin override). Nunca lanza: null = fallback.
 */
export async function resolverCuentaPropia(
  companyId: string,
  codigoMotor: string,
): Promise<ChartAccount | null> {
  const override = await prisma.postingCuentaOverride.findUnique({
    where: { companyId_codigoMotor: { companyId, codigoMotor } },
    include: { cuenta: true },
  });
  if (override) return override.cuenta.isActive ? override.cuenta : null;

  const candidatas = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true, codAgrup: codigoMotor },
    take: 2,
  });
  return candidatas.length === 1 ? candidatas[0] : null;
}

export interface CoberturaCodigo {
  codigoMotor: string;
  estado: "unica" | "override" | "ambigua" | "sin_candidata";
  candidatas: number;
  cuenta?: { cuentaSAT: string; nombre: string };
}

/**
 * Diagnóstico de cobertura: para cada código que el motor usa, ¿resuelve al
 * plan propio y cómo? Lo que salga «ambigua» es la lista de decisiones del
 * contador (una por código, una sola vez). Sólo lectura.
 */
export async function coberturaPlanPropio(
  companyId: string,
  codigosMotor: string[],
): Promise<CoberturaCodigo[]> {
  const out: CoberturaCodigo[] = [];
  for (const codigoMotor of [...new Set(codigosMotor)].sort()) {
    const override = await prisma.postingCuentaOverride.findUnique({
      where: { companyId_codigoMotor: { companyId, codigoMotor } },
      include: { cuenta: true },
    });
    if (override) {
      out.push({
        codigoMotor,
        estado: "override",
        candidatas: 1,
        cuenta: { cuentaSAT: override.cuenta.subcuenta ?? override.cuenta.cuentaSAT, nombre: override.cuenta.nombre },
      });
      continue;
    }
    const candidatas = await prisma.chartAccount.findMany({
      where: { companyId, isActive: true, codAgrup: codigoMotor },
      select: { cuentaSAT: true, subcuenta: true, nombre: true },
    });
    out.push({
      codigoMotor,
      estado: candidatas.length === 1 ? "unica" : candidatas.length === 0 ? "sin_candidata" : "ambigua",
      candidatas: candidatas.length,
      cuenta:
        candidatas.length === 1
          ? { cuentaSAT: candidatas[0].subcuenta ?? candidatas[0].cuentaSAT, nombre: candidatas[0].nombre }
          : undefined,
    });
  }
  return out;
}
