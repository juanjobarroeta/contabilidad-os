// ─────────────────────────────────────────────────────────────────────────────
// Ruta de retorno segura para login / signup / onboarding.
//
// El caso que lo hizo necesario: la página de invitación manda al invitado a
// `/signup?callbackUrl=/invitacion/<token>` — y signup lo IGNORABA y empujaba a
// /onboarding. El cliente invitado nunca volvía a aceptar la invitación, quedaba
// sin membresía y el wizard le pedía crear una empresa y contratar un plan que
// su despacho ya paga.
//
// La validación es deliberadamente estricta porque un callbackUrl abierto es un
// open redirect: la página de login es justo donde un phisher quiere mandar a
// la gente después de robar la contraseña. Sólo se aceptan rutas RELATIVAS de
// esta misma app:
//   • debe empezar con "/"
//   • "//evil.com" no (protocol-relative)
//   • "/\evil.com" no (los navegadores tratan "\" como "/" al resolver)
//   • nada de saltos de línea ni caracteres de control
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta interna válida, o null (el caller decide su default). */
export function rutaRetornoSegura(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const r = raw.trim();
  if (!r.startsWith("/")) return null;
  // "//host" y "/\host": ambos se resuelven como URL absoluta en el navegador.
  if (r.startsWith("//") || r.startsWith("/\\")) return null;
  // Control chars (CR/LF incluidos): nada legítimo los trae en una ruta.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(r)) return null;
  return r;
}
