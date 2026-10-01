// ─────────────────────────────────────────────────────────────────────────────
// Puestos del hospital: roles vivos.
//
// Un puesto junta las PÁGINAS que se ven y las ACCIONES que se pueden hacer
// (permisos). Cada miembro tiene un puesto (o ninguno: «a la medida») y sus
// propios ajustes encima: páginas o permisos de más o de menos.
//
//   efectivo = (puesto ∪ extra) − quitados
//
// El efectivo se GUARDA en CompanyMember.hospitalPaginas/hospitalPermisos,
// que es lo que leen enforceHospitalAccess y requireClinicalPermission: la
// autorización no cambia. Cambiar un puesto recalcula a todos sus miembros
// en la misma transacción.
//
// Ojo con el contrato de hospitalPaginas: [] significa «ve todas». Un puesto
// sin «todas las páginas» que termine sin ninguna se rechaza; si no, el
// usuario vería todo por accidente.
// ─────────────────────────────────────────────────────────────────────────────

import type { MemberRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { AuthzError } from "@/lib/authz";
import { PERMISOS_CLINICOS, type PermisoClinico } from "./permisos";

export const llavePagina = z.string().trim().min(1).max(40);
const permiso = z.enum(PERMISOS_CLINICOS);

export const ajustesSchema = z.object({
  paginasExtra: z.array(llavePagina).max(64).default([]),
  paginasQuitadas: z.array(llavePagina).max(64).default([]),
  permisosExtra: z.array(permiso).default([]),
  permisosQuitados: z.array(permiso).default([]),
});
export type Ajustes = z.infer<typeof ajustesSchema>;
export const SIN_AJUSTES: Ajustes = { paginasExtra: [], paginasQuitadas: [], permisosExtra: [], permisosQuitados: [] };

export const puestoSchema = z.object({
  nombre: z.string().trim().min(2).max(60),
  descripcion: z.string().trim().max(300).nullable().optional(),
  todasLasPaginas: z.boolean().default(false),
  paginas: z.array(llavePagina).max(64).default([]),
  permisos: z.array(permiso).default([]),
});
export type PuestoInput = z.infer<typeof puestoSchema>;

export interface PuestoBase {
  todasLasPaginas: boolean;
  paginas: string[];
  permisos: string[];
}

const unicos = <T>(xs: T[]) => [...new Set(xs)];

/** Lee los ajustes guardados (Json) tolerando null o basura vieja. */
export function leerAjustes(v: unknown): Ajustes {
  const r = ajustesSchema.safeParse(v ?? {});
  return r.success ? r.data : SIN_AJUSTES;
}

/**
 * Páginas y permisos efectivos de un miembro. `paginas: []` = todas (sólo si
 * el puesto ve todas). Lanza 400 si el resultado dejaría «ninguna página»,
 * que el contrato leería como «todas».
 */
export function accesoEfectivo(puesto: PuestoBase | null, ajustes: Ajustes): { paginas: string[]; permisos: PermisoClinico[] } {
  const validos = new Set<string>(PERMISOS_CLINICOS);
  const quitP = new Set(ajustes.permisosQuitados);
  const permisos = unicos([...(puesto?.permisos ?? []), ...ajustes.permisosExtra])
    .filter((p) => validos.has(p) && !quitP.has(p as PermisoClinico)) as PermisoClinico[];

  if (puesto?.todasLasPaginas) {
    if (ajustes.paginasQuitadas.length) {
      throw new AuthzError(400, "Este puesto ve todas las páginas: para quitarle páginas a alguien, dale otro puesto.");
    }
    return { paginas: [], permisos };
  }
  const quit = new Set(ajustes.paginasQuitadas);
  const paginas = unicos([...(puesto?.paginas ?? []), ...ajustes.paginasExtra]).filter((p) => !quit.has(p));
  if (paginas.length === 0) {
    throw new AuthzError(400, "El usuario tiene que ver al menos una página.");
  }
  return { paginas, permisos };
}

/** Sólo lectura no recibe permisos de escritura (mismo criterio que la autorización). */
export function validarRolYPermisos(role: MemberRole, permisos: string[]) {
  if (role === "VIEWER" && permisos.some((p) => p !== "CLINICA_LEER")) {
    throw new AuthzError(400, "Sólo lectura no puede recibir permisos de escritura: cambia el rol a Operativo o quita esos permisos.");
  }
}

/**
 * Recalcula y guarda el acceso efectivo de todos los miembros de un puesto.
 * Un miembro de sólo lectura conserva únicamente lo que puede tener (se le
 * filtra la escritura en vez de romper el guardado del puesto).
 */
export async function recalcularMiembros(tx: Prisma.TransactionClient, puestoId: string) {
  const puesto = await tx.hospPuesto.findUniqueOrThrow({ where: { id: puestoId } });
  const miembros = await tx.companyMember.findMany({
    where: { hospitalPuestoId: puestoId },
    select: { id: true, role: true, hospitalAjustes: true },
  });
  for (const m of miembros) {
    const ef = accesoEfectivo(puesto, leerAjustes(m.hospitalAjustes));
    const permisos = m.role === "VIEWER" ? ef.permisos.filter((p) => p === "CLINICA_LEER") : ef.permisos;
    await tx.companyMember.update({ where: { id: m.id }, data: { hospitalPaginas: ef.paginas, hospitalPermisos: permisos } });
  }
  return miembros.length;
}
