// DB-backed seeding of recurring fiscal obligations. Kept separate from the
// pure `obligaciones.ts` (which client components import) because this touches
// Prisma.

import { prisma } from "./prisma";
import {
  getObligacionesPorRegimen,
  mapCsfObligacion,
  defaultConfigForTipo,
  type ObligacionConfig,
} from "./obligaciones";
import { esPersonaFisicaRfc, requiereDeclaracionAnual } from "@/lib/fiscal/regimen-anual";

/**
 * Seed a company's recurring fiscal obligations (CompanyObligation rows).
 *
 * Source of truth:
 *   1. If the CSF lists explicit obligaciones, those WIN — they reflect what the
 *      SAT actually registered for this taxpayer (e.g. an employee under 605
 *      doesn't file retenciones; a 606 arrendador may also owe DIOT). We keep
 *      the régimen map's periodicity/due-date for each tipo when available,
 *      else fall back to a sensible default. Tagged fuente="CSF".
 *   2. Otherwise (manual entry, no CSF), derive the union of obligations from
 *      all of the company's régimen codes. Tagged fuente="REGIMEN".
 *
 * Idempotent: skips if the company already has obligations unless `force`.
 * Returns the number of obligation types seeded.
 */
export async function seedCompanyObligaciones(
  companyId: string,
  regimenCodes: string[],
  opts: { force?: boolean; csfObligaciones?: string[] } = {}
): Promise<number> {
  const existing = await prisma.companyObligation.count({ where: { companyId } });
  if (existing > 0 && !opts.force) return 0;

  const regimenConfigs = getObligacionesPorRegimen(regimenCodes.join(","));
  const regimenByTipo = new Map(regimenConfigs.map((o) => [o.tipo, o]));

  const csfTipos = [
    ...new Set(
      (opts.csfObligaciones ?? [])
        .map(mapCsfObligacion)
        .filter((t): t is string => !!t)
    ),
  ];

  // CSF list wins when it yields at least one mapped obligation.
  let toSeed: { config: ObligacionConfig; fuente: string }[] =
    csfTipos.length > 0
      ? csfTipos.map((tipo) => ({
          config: regimenByTipo.get(tipo) ?? defaultConfigForTipo(tipo),
          fuente: "CSF",
        }))
      : regimenConfigs.map((config) => ({ config, fuente: "REGIMEN" }));

  // Excepción por régimen: RESICO PF (Art. 113-E, pagos definitivos) NO
  // presenta anual de ISR aunque su CSF liste la obligación — el padrón del
  // SAT la sigue mostrando y el nag terminaba cobrando anuales inexistentes.
  const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  const anualRequerida = requiereDeclaracionAnual({
    regimenes: regimenCodes,
    esPersonaFisica: esPersonaFisicaRfc(empresa?.rfc),
  });
  if (!anualRequerida) {
    toSeed = toSeed.filter(({ config }) => !config.tipo.includes("ANUAL"));
  }

  for (const { config, fuente } of toSeed) {
    await prisma.companyObligation.upsert({
      where: { companyId_tipo: { companyId, tipo: config.tipo } },
      update: {
        descripcion: config.descripcion,
        periodicidad: config.periodicidad,
        diaVencimiento: config.diaVencimiento,
        mesVencimiento: config.mesVencimiento ?? null,
        fuente,
        activa: true,
      },
      create: {
        companyId,
        tipo: config.tipo,
        descripcion: config.descripcion,
        periodicidad: config.periodicidad,
        diaVencimiento: config.diaVencimiento,
        mesVencimiento: config.mesVencimiento ?? null,
        fuente,
      },
    });
  }
  return toSeed.length;
}

/**
 * Agrega (sin tocar las que ya existen) obligaciones a vigilar. Para las que
 * llegan después del alta: una CSF nueva que trae una obligación que no
 * vigilábamos, o la nómina que aparece en los recibos timbrados. Nunca
 * desactiva ni reactiva: si el usuario apagó una, se queda apagada.
 * Devuelve cuántas se crearon.
 */
export async function agregarObligacionesFaltantes(
  companyId: string,
  tipos: string[],
  fuente: string,
): Promise<number> {
  if (tipos.length === 0) return 0;
  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, regimenFiscal: true, regimenes: { select: { code: true } } },
  });
  if (!empresa) return 0;
  const regimenCodes = empresa.regimenes.length ? empresa.regimenes.map((r) => r.code) : [empresa.regimenFiscal].filter(Boolean);
  const anualRequerida = requiereDeclaracionAnual({ regimenes: regimenCodes, esPersonaFisica: esPersonaFisicaRfc(empresa.rfc) });
  const porTipo = new Map(getObligacionesPorRegimen(regimenCodes.join(",")).map((o) => [o.tipo, o]));
  const configs = [...new Set(tipos)]
    .filter((t) => anualRequerida || !t.includes("ANUAL"))
    .map((t) => porTipo.get(t) ?? defaultConfigForTipo(t));
  const r = await prisma.companyObligation.createMany({
    data: configs.map((c) => ({
      companyId,
      tipo: c.tipo,
      descripcion: c.descripcion,
      periodicidad: c.periodicidad,
      diaVencimiento: c.diaVencimiento,
      mesVencimiento: c.mesVencimiento ?? null,
      fuente,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/** Lo que causa tener trabajadores: IMSS (SIPARE), ISN estatal y retenciones de ISR. */
export const OBLIGACIONES_NOMINA = ["IMSS_MENSUAL", "IMSS_BIMESTRAL", "ISN_MENSUAL", "RETENCIONES_ISR"] as const;

/** Tipos a vigilar según las obligaciones de una CSF (las que sabemos mapear). */
export function tiposDeCsf(obligaciones: string[]): string[] {
  return [...new Set(obligaciones.map(mapCsfObligacion).filter((t): t is string => !!t))];
}
