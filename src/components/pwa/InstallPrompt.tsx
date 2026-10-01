"use client";

import { useEffect, useState } from "react";
import { X, Share, Plus } from "lucide-react";
import { esIos, esStandalone, instalar, LLAVE_RECORRIDO, puedeInstalar, suscribirInstalacion } from "@/lib/pwa/instalacion";

const DISMISS_KEY = "pwa-install-dismissed";

/**
 * Lightweight "instala la app" nudge. On Android/Chrome it uses the native
 * beforeinstallprompt; on iOS (which has no prompt API) it shows the manual
 * "Compartir → Agregar a inicio" instructions. Dismissible + remembered.
 */
export function InstallPrompt() {
  const [show, setShow] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISS_KEY)) return;
    // Durante el alta lo ofrece el paso «Descarga la app».
    if (localStorage.getItem(LLAVE_RECORRIDO)) return;

    // Already installed (standalone) → never show.
    if (esStandalone()) return;

    if (esIos()) {
      setIosHint(true);
      setShow(true);
      return;
    }

    // El evento lo captura src/lib/pwa/instalacion.ts (lo comparte con el alta).
    const revisar = () => setShow(puedeInstalar());
    revisar();
    return suscribirInstalacion(revisar);
  }, []);

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  async function install() {
    await instalar();
    dismiss();
  }

  if (!show) return null;

  return (
    <div className="fixed bottom-4 inset-x-4 z-[70] mx-auto max-w-md rounded-xl border border-cos-line bg-cos-card shadow-lg p-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-cos-brand text-white flex items-center justify-center font-bold shrink-0">
          C
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Instala ContabilidadOS</p>
          {iosHint ? (
            <p className="text-xs text-cos-ink-soft mt-0.5">
              Toca <Share className="inline h-3 w-3" /> Compartir y luego{" "}
              <span className="whitespace-nowrap"><Plus className="inline h-3 w-3" /> Agregar a inicio</span>.
            </p>
          ) : (
            <p className="text-xs text-cos-ink-soft mt-0.5">
              Agrégala a tu pantalla de inicio para abrirla como app.
            </p>
          )}
          {!iosHint && (
            <button
              onClick={install}
              className="mt-2 text-xs font-medium bg-cos-brand text-white px-3 py-1.5 rounded-md hover:bg-cos-brand-deep/90"
            >
              Instalar
            </button>
          )}
        </div>
        <button onClick={dismiss} aria-label="Cerrar" className="p-1 rounded hover:bg-cos-paper text-cos-ink-soft">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
