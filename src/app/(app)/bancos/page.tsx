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
//   Movimientos   el archivo: todos los meses de corrido, con el detalle del
//                 cruce, las devoluciones y las comisiones
//   Cuentas       alta/edición, importar estados, deshacer lotes
//   Histórico     qué se casó con qué, con Desconciliar a la mano
//
// EL REPARTO: la mesa DECIDE (conciliar, categorizar, en lote), el archivo
// BUSCA Y MUESTRA. El triage estaba en los dos y por eso seguían sintiéndose
// dos mesas; ahora el archivo entrega el movimiento con «Resolver en la mesa»
// (?year=&month=&tx=) en vez de resolverlo por su cuenta.
//
// Deep links: ?tab=movimientos|cuentas|historico (sin ?tab = la mesa);
// ?year=&month=&tx= abre la mesa en ese mes con ese movimiento elegido.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading } from "@/components/ui/feedback";
import { ConciliacionWorkbench } from "@/components/contabilidad/ConciliacionWorkbench";
import { GestionBancos, type VistaBancos } from "@/components/bancos/GestionBancos";
import { TopTabsBar } from "@/components/layout/TopTabsBar";
import { MESES } from "@/components/contabilidad/PeriodProvider";

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

/** `?year=&month=&tx=` — el archivo (tab Movimientos) entrega un movimiento a
 *  la mesa: su mes en el encabezado y él seleccionado. Se lee UNA vez al
 *  montar, igual que el tab; después el período vive en estado. */
function periodoInicial(): { year: number; month: number; tx: string | null } {
  const hoy = new Date();
  const base = { year: hoy.getFullYear(), month: hoy.getMonth() + 1, tx: null as string | null };
  if (typeof window === "undefined") return base;
  const q = new URLSearchParams(window.location.search);
  const y = Number(q.get("year"));
  const m = Number(q.get("month"));
  // Sin un período válido y completo se ignora: medio parámetro llevaría a un
  // mes que nadie pidió.
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) return base;
  return { year: y, month: m, tx: q.get("tx") };
}

export default function BancosPage() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [tab, setTab] = useState<Tab>(tabInicial);
  // Período de la mesa (el archivo trae su propio corte por mes).
  const [inicial] = useState(periodoInicial);
  const [year, setYear] = useState(inicial.year);
  const [month, setMonth] = useState(inicial.month);
  // El movimiento que llegó por `?tx=`: la mesa lo selecciona al montar y
  // luego se suelta, para que navegar no lo reviva.
  const [txInicial, setTxInicial] = useState<string | null>(inicial.tx);
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
    // Cambiar de mes deja atrás el movimiento entregado: su `?tx=` en la barra
    // de direcciones prometería una selección que ya no existe.
    if (txInicial) { setTxInicial(null); window.history.replaceState(null, "", "/bancos"); }
  }

  if (!activeCompany) {
    // Mientras el CompanyProvider carga aún no se sabe qué empresa está
    // activa: pintar "Selecciona una empresa." aquí era un destello falso en
    // cada entrada a la página.
    if (companyLoading) return <Loading className="p-8" />;
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  return (
    <div>
      <TopTabsBar
        ariaLabel="Secciones de Bancos"
        innerClassName="max-w-[1060px]"
        tabs={TABS.map(({ id, label }) => ({ key: id, label, active: tab === id, onSelect: () => irA(id) }))}
      />
      <div className="mx-auto max-w-[1060px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Bancos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">
            {tab === "movimientos"
              ? "El archivo de tus cuentas: todos los meses de corrido. El trabajo del período se hace en Conciliación."
              : "Conectamos los movimientos de tu banco con tus facturas para que todo cuadre."}
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

      <div className="mt-5">
        {tab === "conciliacion" ? (
          <ConciliacionWorkbench
            companyId={activeCompany.id}
            year={year}
            month={month}
            txInicial={txInicial}
            onApplied={() => setVersion((v) => v + 1)}
          />
        ) : (
          <GestionBancos key={`${tab}-${version}`} vista={tab} />
        )}
      </div>
      </div>
    </div>
  );
}
