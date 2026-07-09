// ─────────────────────────────────────────────────────────────────────────────
// Admin de PLATAFORMA (el operador del SaaS), distinto de los roles OWNER/ADMIN
// de un despacho o empresa: esos administran SU organización; esto administra
// el producto (p.ej. generar códigos de descuento en Stripe). Se gobierna con
// la variable de entorno PLATFORM_ADMIN_EMAILS (correos separados por coma) —
// sin cambio de esquema. Lista vacía o ausente = nadie es admin (falla cerrado).
// ─────────────────────────────────────────────────────────────────────────────

export function esAdminPlataforma(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!email) return false;
  const lista = (env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return lista.includes(email.trim().toLowerCase());
}
