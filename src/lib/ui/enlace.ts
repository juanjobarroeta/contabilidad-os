// ─────────────────────────────────────────────────────────────────────────────
// ¿Este enlace sale de la app o se queda dentro? Puro.
//
// El renderizador de markdown del copiloto abría TODOS los enlaces en pestaña
// nueva. Para una liga al SAT está bien; para «Mapear cuentas»
// (/contabilidad/catalogo) no: abrir una ruta propia en otra pestaña arranca la
// aplicación entera de cero —sesión, empresa activa, periodo— y el contador
// termina con dos copias de la app abiertas en vez de haber avanzado un paso.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rutas de la propia app: absolutas ("/contabilidad/catalogo", con query o
 * ancla) y anclas de la misma página ("#diot"). Todo lo demás —http(s) a otro
 * sitio, mailto:, tel:, protocolos raros— es externo.
 *
 * `//otro.com` NO es interno aunque empiece con "/": es un URL relativo al
 * protocolo y apunta fuera.
 */
export function esEnlaceInterno(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (h === "") return false;
  if (h.startsWith("//")) return false;
  return h.startsWith("/") || h.startsWith("#");
}
