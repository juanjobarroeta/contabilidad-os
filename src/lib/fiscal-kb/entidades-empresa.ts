// ─────────────────────────────────────────────────────────────────────────────
// ¿En qué estados opera la empresa? Para que el copiloto busque la ley FEDERAL
// más la de SUS estados, y no la de los 32 revueltos (un ISN de Puebla citando
// la Ley de Hacienda de Jalisco).
//
// Fuentes: el CP del domicilio fiscal y el estado de cada empleado activo
// (ClaveEntFed del recibo de nómina) — ahí aparecen las sucursales, que pagan
// ISN donde trabaja la gente.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { esEntidad, estadoDesdeCP, type Entidad } from "@/lib/fiscal/rules";

export interface EntidadesEmpresa {
  /** Entidad del domicilio fiscal (por CP). */
  domicilio: Entidad | null;
  /** Domicilio primero, luego las de nómina (sucursales), sin repetir. */
  todas: Entidad[];
}

export function combinarEntidades(codigoPostal: string | null | undefined, clavesNomina: string[]): EntidadesEmpresa {
  const domicilio = estadoDesdeCP(codigoPostal) ?? null;
  const todas = new Set<Entidad>(domicilio ? [domicilio] : []);
  for (const c of clavesNomina) {
    const e = c?.trim().toUpperCase();
    if (esEntidad(e)) todas.add(e);
  }
  return { domicilio, todas: [...todas] };
}

export async function entidadesDeEmpresa(companyId: string): Promise<EntidadesEmpresa> {
  const [company, empleados] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { codigoPostal: true } }),
    prisma.employee.findMany({
      where: { companyId, isActive: true },
      select: { claveEntFed: true },
      distinct: ["claveEntFed"],
    }),
  ]);
  return combinarEntidades(company?.codigoPostal, empleados.map((e) => e.claveEntFed));
}
