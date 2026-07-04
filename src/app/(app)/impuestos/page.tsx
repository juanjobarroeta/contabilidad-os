"use client";

import { useEffect, useState } from "react";
import { DeclaracionWorkspace } from "@/components/declaraciones/DeclaracionWorkspace";
import { DeclaracionesList } from "@/components/declaraciones/DeclaracionesList";
import { DeclaracionAnualView } from "@/components/declaraciones/DeclaracionAnualView";

// Hub fiscal de Impuestos. Reúne en un solo lugar, con una barra de pestañas,
// las tres vistas que antes vivían en rutas separadas:
//   Del mes   → workspace de la declaración del mes (/declaracion)
//   Historial → captura y acuses de declaraciones (/declaraciones)
//   Anual     → declaración anual (/declaracion-anual)
// La pestaña activa se controla con ?tab=. Las rutas antiguas redirigen aquí
// preservando month/year, así que los enlaces profundos siguen funcionando.

type Tab = "del-mes" | "historial" | "anual";

const TABS: { id: Tab; label: string }[] = [
  { id: "del-mes", label: "Del mes" },
  { id: "historial", label: "Historial" },
  { id: "anual", label: "Anual" },
];

export default function ImpuestosHubPage() {
  const [tab, setTab] = useState<Tab>("del-mes");

  // Honra el deep-link ?tab=. Se lee directo de la URL para evitar forzar un
  // límite de Suspense (useSearchParams).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "del-mes" || t === "historial" || t === "anual") setTab(t);
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    // Mantén la URL en sincronía sin recargar, conservando month/year.
    const sp = new URLSearchParams(window.location.search);
    sp.set("tab", next);
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }

  return (
    <div>
      <div className="border-b border-cos-line px-4 sm:px-8">
        <div
          role="tablist"
          aria-label="Secciones de impuestos"
          className="mx-auto flex max-w-[1000px] snap-x gap-1 overflow-x-auto"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={`-mb-px shrink-0 snap-start whitespace-nowrap border-b-2 px-3.5 py-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint ${
                tab === t.id
                  ? "border-cos-brand text-cos-brand-ink"
                  : "border-transparent text-cos-ink-soft hover:text-cos-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "del-mes" && <DeclaracionWorkspace />}
      {tab === "historial" && <DeclaracionesList />}
      {tab === "anual" && <DeclaracionAnualView />}
    </div>
  );
}
