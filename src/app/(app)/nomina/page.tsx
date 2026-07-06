"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import ResumenTab from "./ResumenTab";
import CorridasTab from "./CorridasTab";
import EmpleadosTab from "./EmpleadosTab";
import CumplimientoTab from "./CumplimientoTab";

// Hub de Nómina. Reúne en un solo lugar, con una barra de pestañas (mismo
// patrón que el hub de Impuestos), las vistas que antes vivían fragmentadas:
//   Resumen      → la vista amigable que era /nomina (banner, validación
//                  paralela, cuotas IMSS/SIPARE, última corrida)
//   Corridas     → el workspace power-user que era /nomina/detalle (corridas,
//                  prefill, incidencias, timbrado, dispersión)
//   Empleados    → roster con búsqueda y enlace al expediente de cada empleado
//   Cumplimiento → SUA/IDSE, cuotas IMSS y validación del cálculo
// La pestaña activa se controla con ?tab=. La ruta antigua /nomina/detalle
// redirige a ?tab=corridas (next.config.ts). El cockpit multi-RFC
// (/nomina/cockpit) sigue siendo página propia — se enlaza desde aquí para
// quien opera varias empresas.

type Tab = "resumen" | "corridas" | "empleados" | "cumplimiento";

const TABS: { id: Tab; label: string }[] = [
  { id: "resumen", label: "Resumen" },
  { id: "corridas", label: "Corridas" },
  { id: "empleados", label: "Empleados" },
  { id: "cumplimiento", label: "Cumplimiento" },
];

const TAB_IDS = TABS.map((t) => t.id);

export default function NominaHubPage() {
  const { companies } = useCompany();
  const [tab, setTab] = useState<Tab>("resumen");

  // Honra el deep-link ?tab= Y sus cambios en vivo: la sección Nómina del
  // sidebar navega entre pestañas con enlaces ?tab=, así que hay que reaccionar
  // a cada cambio del parámetro, no sólo al montar. (Las rutas bajo (app) son
  // dinámicas — el layout lee la sesión — así que useSearchParams no exige un
  // límite de Suspense propio.)
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  useEffect(() => {
    if (tabParam && (TAB_IDS as string[]).includes(tabParam)) setTab(tabParam as Tab);
  }, [tabParam]);

  function selectTab(next: Tab) {
    setTab(next);
    // Mantén la URL en sincronía sin recargar, conservando los demás params.
    const sp = new URLSearchParams(window.location.search);
    sp.set("tab", next);
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }

  return (
    <div>
      <div className="border-b border-cos-line px-4 sm:px-8">
        <div className="mx-auto flex max-w-[1000px] items-center gap-1">
          {/* min-w-0 permite que el tablist se encoja y haga scroll horizontal en
              móvil en vez de empujar el enlace al cockpit fuera de la pantalla. */}
          <div
            role="tablist"
            aria-label="Secciones de nómina"
            className="flex min-w-0 flex-1 snap-x gap-1 overflow-x-auto"
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
          {/* multi-RFC: el cockpit de despacho sigue siendo página propia */}
          {companies.length > 1 && (
            <Link
              href="/nomina/cockpit"
              className="inline-flex flex-none items-center gap-1.5 py-3 text-[13px] font-medium text-cos-ink-soft hover:text-cos-brand-ink"
              title="La nómina de todas tus empresas en un solo panel"
            >
              <Building2 className="h-4 w-4" />
              <span className="hidden sm:inline">Tablero multi-RFC</span>
            </Link>
          )}
        </div>
      </div>

      {tab === "resumen" && <ResumenTab onTab={selectTab} />}
      {tab === "corridas" && <CorridasTab />}
      {tab === "empleados" && <EmpleadosTab />}
      {tab === "cumplimiento" && <CumplimientoTab />}
    </div>
  );
}
