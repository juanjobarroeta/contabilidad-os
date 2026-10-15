import { tieneClinicalPermission } from "./permisos";

/** Ligar renglones de CFDI al catálogo: escritor y, además, dueño/admin o con permiso de compras o finanzas. */
export async function puedeLigarCfdi(companyId: string, userId: string, rol: string): Promise<boolean> {
  if (rol === "VIEWER") return false;
  if (rol === "OWNER" || rol === "ADMIN") return true;
  return (await tieneClinicalPermission(companyId, userId, "COMPRAS_AUTORIZAR")) || (await tieneClinicalPermission(companyId, userId, "FINANZAS_ESCRIBIR"));
}
