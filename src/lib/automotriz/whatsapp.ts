// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de la cola de WhatsApp (fase 2b): normalización de teléfonos y
// links wa.me. Sin API de Meta — el link abre WhatsApp con el mensaje escrito
// y el asesor decide enviarlo. La Cloud API (fase 2c) reusará esto.
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza a formato wa.me: dígitos con lada de país (52 para 10 dígitos MX). */
export function telefonoWa(telefono: string): string | null {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length === 10) return `52${digitos}`;
  if (digitos.length === 12 && digitos.startsWith("52")) return digitos;
  // Formato viejo de móvil MX (521 + 10 dígitos) → wa.me usa 52 + 10.
  if (digitos.length === 13 && digitos.startsWith("521")) return `52${digitos.slice(3)}`;
  return digitos.length >= 11 && digitos.length <= 15 ? digitos : null;
}

export const linkWa = (telefonoNormalizado: string, mensaje: string) =>
  `https://wa.me/${telefonoNormalizado}?text=${encodeURIComponent(mensaje)}`;
