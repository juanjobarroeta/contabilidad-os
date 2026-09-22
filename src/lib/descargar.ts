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
// OJO: «standalone» NO basta para decidir. macOS también instala la app (Safari
// «Agregar al Dock», Chrome «Instalar»), también implementa navigator.share, y
// SÍ tiene gestor de descargas. Ahí la hoja de compartir es un estorbo: el
// owner pidió el PDF de un CFDI en Facturas y le salió la tarjeta de compartir
// de macOS en vez de la descarga. La hoja sólo aplica donde <a download> de
// veras no opera: iOS/iPadOS.
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

/**
 * ¿Es un dispositivo SIN gestor de descargas dentro de la app instalada?
 *
 * Sólo iOS/iPadOS: ahí el click de `<a download>` se traga en silencio y la
 * hoja de compartir es el único camino honesto. Todo escritorio —macOS
 * incluido, aunque la app esté en el Dock— descarga normal, así que la hoja
 * sobra y confunde.
 *
 * Se mira el user agent porque no hay feature-detection fiable: Safari iOS
 * dice que soporta `download` aunque en standalone no haga nada.
 */
export function sinGestorDeDescargas(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ se anuncia como «Macintosh»: lo delata el multitáctil. Un Mac
  // de verdad reporta 0 (o 1 con pantalla táctil externa, que igual descarga).
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
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
 * Entrega un blob al usuario: hoja de compartir SÓLO en la PWA de iOS/iPadOS
 * (donde `<a download>` no opera), ancla clásica en todo lo demás —navegador
 * normal y app instalada en escritorio. Cancelar la hoja no es un error.
 */
export async function descargarBlob(blob: Blob, nombre: string): Promise<void> {
  if (esStandalone() && sinGestorDeDescargas() && typeof navigator.share === "function") {
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
