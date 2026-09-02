// ─────────────────────────────────────────────────────────────────────────────
// Descarga de archivos que FUNCIONA en la PWA instalada.
//
// El truco clásico (blob → <a download> → click) no hace nada en modo
// standalone de iOS: ahí no hay gestor de descargas y el click se traga en
// silencio — el usuario "veía pero no podía descargar" (reporte real del
// owner). En la PWA el equivalente honesto de descargar es la HOJA DE
// COMPARTIR: Web Share API con el archivo, donde «Guardar en Archivos» vive.
// En navegador normal, el ancla de siempre.
//
// Módulo de CLIENTE (usa window/navigator). No importar desde el servidor.
// ─────────────────────────────────────────────────────────────────────────────

/** ¿Corremos como app instalada (standalone), donde <a download> no opera? */
export function esStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS marca la PWA con navigator.standalone (no estándar).
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function descargarConAncla(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revocar en el siguiente tick rompe la descarga en Safari; con margen no.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Entrega un blob al usuario: hoja de compartir en la PWA (si el dispositivo
 * comparte archivos), ancla clásica en el navegador. Cancelar la hoja de
 * compartir no es un error.
 */
export async function descargarBlob(blob: Blob, nombre: string): Promise<void> {
  if (esStandalone() && typeof navigator.share === "function") {
    const file = new File([blob], nombre, { type: blob.type || "application/octet-stream" });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: nombre });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // el usuario cerró la hoja
        // Cualquier otro fallo: caer al ancla — peor es no entregar nada.
      }
    }
  }
  descargarConAncla(blob, nombre);
}

/**
 * Descarga una URL del MISMO origen (con la sesión) y la entrega con
 * descargarBlob. `nombre` es el respaldo si el servidor no manda
 * Content-Disposition. Si el fetch falla, navega al href (comportamiento
 * previo): en navegador funciona, y en la PWA al menos el error del servidor
 * se ve en pantalla.
 */
export async function descargarUrl(url: string, nombre: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cd = res.headers.get("Content-Disposition") ?? "";
    const delServidor = /filename="([^"]+)"/.exec(cd)?.[1];
    await descargarBlob(await res.blob(), delServidor ?? nombre);
  } catch {
    window.location.href = url;
  }
}
