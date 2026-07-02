"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { leerAskParam } from "@/lib/notif-ask";

// ─────────────────────────────────────────────────────────────────────────────
// Handler GLOBAL: "el tap de una notificación abre el chat con contexto".
//
// Cuando el usuario abre una notificación (push o item del inbox), aterriza en
// la pantalla del pendiente con `?ask=<dedupeKey>` en la URL. Aquí lo leemos,
// recuperamos el pendiente del usuario y disparamos `cos:ask-ai` con un `seed`
// (el ChatPanel lo pre-carga en el input; NO se envía solo — el usuario decide).
// Luego quitamos `ask` de la URL para que un refresh no vuelva a abrirlo.
//
// Se monta junto al <ChatPanel/> en el layout de (app).
// ─────────────────────────────────────────────────────────────────────────────

interface NotifItem {
  id: string;
  titulo: string;
  cuerpo: string;
  url: string;
  categoria: string;
}

function AbrirChatDesdeNotifInner() {
  const searchParams = useSearchParams();
  const ask = leerAskParam(searchParams.toString());
  // Evita re-disparar por el mismo valor (StrictMode / re-render / re-nav).
  const manejadoRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ask || manejadoRef.current === ask) return;
    manejadoRef.current = ask;

    let cancelado = false;

    // Quita `ask` de la URL sin recargar ni navegar (evita re-abrir al refrescar).
    const limpiarUrl = () => {
      const params = new URLSearchParams(window.location.search);
      params.delete("ask");
      const qs = params.toString();
      const nueva =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", nueva);
    };

    (async () => {
      try {
        const res = await fetch(
          `/api/notificaciones?dedupeKey=${encodeURIComponent(ask)}`,
        );
        if (cancelado) return;
        if (res.ok) {
          const item: NotifItem = await res.json();
          const seed = `Sobre "${item.titulo}": ${item.cuerpo}\n\n¿Qué me recomiendas y me ayudas a resolverlo?`;
          window.dispatchEvent(
            new CustomEvent("cos:ask-ai", { detail: { seed } }),
          );
        }
      } catch {
        // Sin conexión o item ausente: no abrimos el chat, sólo limpiamos.
      } finally {
        if (!cancelado) limpiarUrl();
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [ask]);

  return null;
}

export function AbrirChatDesdeNotif() {
  // useSearchParams exige un límite de Suspense en render estático.
  return (
    <Suspense fallback={null}>
      <AbrirChatDesdeNotifInner />
    </Suspense>
  );
}
