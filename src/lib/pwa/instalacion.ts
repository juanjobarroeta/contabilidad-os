// ─────────────────────────────────────────────────────────────────────────────
// Instalar la app (PWA). El navegador dispara `beforeinstallprompt` UNA vez;
// quien lo capture primero es el único que puede abrir el diálogo nativo. Lo
// capturamos aquí, al cargar el módulo, y lo comparten el aviso flotante
// (InstallPrompt) y el paso «Descarga la app» del alta.
// iOS no tiene diálogo: sólo «Compartir → Agregar a inicio».
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventoInstalacion = any;

let evento: EventoInstalacion | null = null;
const subs = new Set<() => void>();
const avisar = () => subs.forEach((f) => f());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    evento = e;
    avisar();
  });
  window.addEventListener("appinstalled", () => {
    evento = null;
    avisar();
  });
}

export function puedeInstalar(): boolean {
  return evento != null;
}

export function suscribirInstalacion(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** Abre el diálogo nativo. true si el usuario aceptó. */
export async function instalar(): Promise<boolean> {
  if (!evento) return false;
  const e = evento;
  e.prompt();
  const r = await e.userChoice.catch(() => null);
  evento = null;
  avisar();
  return r?.outcome === "accepted";
}

export function esStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).standalone === true
  );
}

export function esIos(): boolean {
  return typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function esMovil(): boolean {
  return typeof navigator !== "undefined" && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/** Mientras corre el alta (recorrido + descarga), el aviso flotante se calla. */
export const LLAVE_RECORRIDO = "cos-recorrido";
