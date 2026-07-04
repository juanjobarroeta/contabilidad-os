"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MessageCircle, ChevronRight, X } from "lucide-react";

// Aviso en el tablero para vincular WhatsApp. Aparece solo si el canal está
// configurado en el servidor, el usuario aún no tiene un vínculo verificado, y
// no ha descartado el aviso (localStorage, sin estado en servidor). Así un
// usuario recién salido del onboarding descubre la función sin ir a buscarla a
// Configuración. Se auto-oculta al vincular.
const DISMISS_KEY = "cos:whatsapp-nudge-dismissed";

export function WhatsappNudge() {
  const [mostrar, setMostrar] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1") {
      return;
    }
    let vivo = true;
    fetch("/api/whatsapp/link")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!vivo || !d) return;
        const yaVinculado = Array.isArray(d.links) && d.links.some((l: { verifiedAt: string | null }) => l.verifiedAt);
        if (d.available && !yaVinculado) setMostrar(true);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  if (!mostrar) return null;

  return (
    <div className="flex items-start gap-4 rounded-card bg-cos-jade-tint px-6 py-[18px]">
      <div className="grid h-11 w-11 flex-none place-items-center rounded-[13px] bg-cos-jade text-white">
        <MessageCircle className="h-[22px] w-[22px]" strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-cos-jade-ink">
          Lleva tu contabilidad a WhatsApp
        </h2>
        <p className="mt-1 text-[14px] leading-snug text-cos-jade-ink opacity-90">
          Vincula tu WhatsApp para preguntar por tus impuestos, subir estados de cuenta
          con una foto y conciliar desde tu teléfono. Toma menos de un minuto.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href="/configuracion/whatsapp"
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-jade px-3.5 py-2 text-[13.5px] font-semibold text-white hover:opacity-90"
          >
            Vincular WhatsApp <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
      <button
        type="button"
        aria-label="Descartar"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setMostrar(false);
        }}
        className="flex-none rounded-md p-1 text-cos-jade-ink opacity-60 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
