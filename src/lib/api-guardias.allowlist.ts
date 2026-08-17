/**
 * Allowlist del test estático de guardias (api-guardias.test.ts).
 *
 * REGLA DE ORO: agregar una ruta aquí es una decisión de seguridad revisada,
 * no una forma de silenciar el test. Cada entrada lleva su razón. El test
 * falla si una entrada apunta a un archivo que ya no existe o que ya tiene
 * guardia reconocida (entradas rancias se PODAN, no se acumulan).
 *
 * Revisión inicial: 2026-08-17, leyendo cada ruta listada (no de oídas).
 */

export type EntradaAllowlist = {
  /** Ruta relativa a src/app, estilo "api/auth/signup/route.ts" */
  ruta: string;
  /** Por qué esta ruta puede vivir sin la guardia que el test exige */
  razon: string;
};

/**
 * Rutas SIN ningún autenticador conocido — públicas a propósito.
 * (Rule 1 del test.)
 */
export const RUTAS_PUBLICAS: EntradaAllowlist[] = [
  {
    ruta: "api/auth/[...nextauth]/route.ts",
    razon:
      "Handler de NextAuth (login/logout/session). El rate limit del login vive dentro de authorize() en src/lib/auth.ts.",
  },
  {
    ruta: "api/auth/signup/route.ts",
    razon: "Alta pública de cuenta; rate limit por IP y por email en el propio handler.",
  },
  {
    ruta: "api/auth/token/route.ts",
    razon:
      "Canje de credenciales por bearer para satélites; las credenciales SON la autenticación, con rate limit propio.",
  },
  {
    ruta: "api/auth/token/refresh/route.ts",
    razon:
      "Canje de refresh token rotatorio (hash en BD, detección de reuso con revocación en cadena); el token ES la autenticación.",
  },
  {
    ruta: "api/automotriz/portal/login/route.ts",
    razon: "Login del portal de clientes finales; credenciales + rate limit en el handler.",
  },
  {
    ruta: "api/purificadora/portal/login/route.ts",
    razon: "Login del portal de clientes finales; credenciales + rate limit en el handler.",
  },
  {
    ruta: "api/password-reset/confirm/route.ts",
    razon:
      "Canje del token de restablecimiento (hasheado en BD) por contraseña nueva; token = autenticación, con rate limit y zod.",
  },
  {
    ruta: "api/onboarding-invites/preview/route.ts",
    razon:
      "Preview pública de invitación por token hasheado; responde difuminado y nunca revela el token ni datos internos.",
  },
  {
    ruta: "api/csp-report/route.ts",
    razon:
      "Receptor de violaciones del CSP Report-Only (P0-5): los navegadores postean sin sesión. Rate limit por IP, tope de tamaño, sólo loguea un resumen y responde 204.",
  },
];

/**
 * Rutas que MENCIONAN companyId pero cuya autorización de tenant no usa los
 * mecanismos de scoping reconocidos. (Rule 2 del test.)
 */
export const RUTAS_CON_AUTH_PROPIA: EntradaAllowlist[] = [
  {
    ruta: "api/despacho/members/[userId]/companies/route.ts",
    razon:
      "Check inline de OWNER/ADMIN del despacho del caller; valida que el miembro objetivo y cada companyId pertenezcan a ESE despacho antes de tocar el scoping.",
  },
  {
    ruta: "api/invitations/[token]/route.ts",
    razon:
      "El token de invitación ES la autorización sobre esa empresa; la sesión sólo identifica al aceptante y se cruza contra el email invitado.",
  },
  {
    ruta: "api/notificaciones/route.ts",
    razon:
      "Buzón personal: toda query filtra por recipientUserId de la sesión; companyId es columna del item, nunca filtro del caller.",
  },
  {
    ruta: "api/onboarding-invites/[id]/route.ts",
    razon: "Invitación amarrada al email de la sesión; sin acceso a datos de otra empresa.",
  },
  {
    ruta: "api/push/subscribe/route.ts",
    razon:
      "Suscripción push del propio usuario (upsert por userId de sesión). OJO: el companyId del body se guarda SIN validar membresía — hoy es metadato inerte (todos los senders seleccionan por userId), pero cualquier sender futuro que filtre por subscription.companyId confiaría en dato manipulable. Follow-up P0-2: validar membresía o dejar de guardarlo.",
  },
  {
    ruta: "api/verificador/route.ts",
    razon:
      "Usa su propio companyIdsVisibles(userId). HALLAZGO documentado en el PR: duplica empresasAccesiblesIds SIN respetar el scoping por DespachoMemberCompany (un miembro de despacho restringido a la empresa X ve terceros conocidos de la empresa Y). Propuesta: sustituir por empresasAccesiblesIds — toca lógica de tenant-scoping (lista no-go), requiere aprobación del owner.",
  },
];
