"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /bancos — LA MESA AL FRENTE.
//
// Todos los CTAs del producto («Ir a Bancos», «Clasificar en Bancos», los del
// tablero) mandan aquí, pero la mesa de conciliación split-view vivía en
// /contabilidad/conciliacion, a donde sólo llegaba quien navegara el flujo de
// cierre. El producto prometía la mesa y entregaba el monolito de 1,798
// líneas. Ahora /bancos abre con la mesa (ConciliacionWorkbench, el MISMO
// componente — no una copia) y el resto del monolito vive en tabs:
//
//   Conciliación  la mesa: banco ↔ CFDIs cuadrando a cero   (default)
//   Movimientos   el triage fino: filtros, similares, lotes
//   Cuentas       alta/edición, importar estados, deshacer lotes
//   Histórico     qué se casó con qué, con Desconciliar a la mano
//
// Deep links: ?tab=movimientos|cuentas|historico (sin ?tab = la mesa).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading } from "@/components/ui/feedback";
import { ConciliacionWorkbench } from "@/components/contabilidad/ConciliacionWorkbench";
import { GestionBancos, type VistaBancos } from "@/components/bancos/GestionBancos";
import { MESES } from "@/components/contabilidad/PeriodProvider";
import { cn } from "@/lib/utils";

type Tab = "conciliacion" | VistaBancos;

const TABS: { id: Tab; label: string }[] = [
  { id: "conciliacion", label: "Conciliación" },
  { id: "movimientos", label: "Movimientos" },
  { id: "cuentas", label: "Cuentas" },
  { id: "historico", label: "Histórico" },
];

/** `?tab=` inicial. Lazy useState (mismo patrón que facturas/nueva): se lee una
 *  vez al montar — el tab luego vive en estado y se refleja con replaceState. */
function tabInicial(): Tab {
  if (typeof window === "undefined") return "conciliacion";
  const t = new URLSearchParams(window.location.search).get("tab");
  return t === "movimientos" || t === "cuentas" || t === "historico" ? t : "conciliacion";
}

export default function BancosPage() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [tab, setTab] = useState<Tab>(tabInicial);
  // Período de la mesa (la lista de Movimientos trae su propio corte por mes).
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  // Remonta el tab activo tras conciliar en la mesa, para que las listas
  // (movimientos/histórico) relean al volver.
  const [version, setVersion] = useState(0);

  function irA(t: Tab) {
    setTab(t);
    const url = t === "conciliacion" ? "/bancos" : `/bancos?tab=${t}`;
    window.history.replaceState(null, "", url);
  }
  function moverPeriodo(delta: number) {
    const idx = year * 12 + (month - 1) + delta;
    setYear(Math.floor(idx / 12));
    setMonth((idx % 12) + 1);
  }

  if (!activeCompany) {
    // Mientras el CompanyProvider carga aún no se sabe qué empresa está
    // activa: pintar "Selecciona una empresa." aquí era un destello falso en
    // cada entrada a la página.
    if (companyLoading) return <Loading className="p-8" />;
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-[1060px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Bancos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">
            Conectamos los movimientos de tu banco con tus facturas para que todo cuadre.
          </p>
        </div>
        {/* El período manda sobre la mesa; Movimientos/Histórico traen su
            propio corte por mes dentro de su barra de filtros. */}
        {tab === "conciliacion" && (
          <div className="flex items-center gap-1">
            <button onClick={() => moverPeriodo(-1)} aria-label="Período anterior"
              className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[130px] text-center text-[15px] font-semibold text-cos-ink">
              {MESES[month - 1]} {year}
            </span>
            <button onClick={() => moverPeriodo(1)} aria-label="Período siguiente"
              className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <nav aria-label="Secciones de Bancos" className="mt-4 flex flex-wrap gap-1 border-b border-cos-line">
        {TABS.map(({ id, label }) => (
          <button key={id} onClick={() => irA(id)} aria-current={tab === id ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-[13.5px] font-medium transition-colors",
              tab === id
                ? "border-cos-brand text-cos-brand-ink"
                : "border-transparent text-cos-ink-soft hover:border-cos-line hover:text-cos-ink"
            )}>
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === "conciliacion" ? (
          <ConciliacionWorkbench
            companyId={activeCompany.id}
            year={year}
            month={month}
            onApplied={() => setVersion((v) => v + 1)}
          />
        ) : (
          <GestionBancos key={`${tab}-${version}`} vista={tab} />
        )}
      </div>
    </div>
  );
}
