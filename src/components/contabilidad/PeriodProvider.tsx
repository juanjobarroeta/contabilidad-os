"use client";

// ─────────────────────────────────────────────────────────────────────────────
// El período es el contexto global de la sección contabilidad (brief UX):
// se elige una vez y persiste en todos los módulos del flujo de cierre.
//
// Prioridad de inicialización: ?y=&m= en la URL (deep-links) → localStorage
// por empresa (vuelve donde se quedó) → mes actual. Se hidrata en efecto para
// no desincronizar el render del servidor.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";

export const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

interface PeriodContextValue {
  year: number;
  month: number; // 1–12 (el mes 13 del cierre anual se maneja en Entregables)
  setPeriod: (year: number, month: number) => void;
  /** "Julio 2026" — para headers y subtítulos. */
  label: string;
}

const now = new Date();

const PeriodContext = createContext<PeriodContextValue>({
  year: now.getFullYear(),
  month: now.getMonth() + 1,
  setPeriod: () => {},
  label: "",
});

const storageKey = (companyId: string) => `cos-periodo:${companyId}`;

export function PeriodProvider({ children }: { children: ReactNode }) {
  const { activeCompany } = useCompany();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Hidratar desde URL o localStorage una vez que conocemos la empresa.
  useEffect(() => {
    if (!activeCompany) return;
    const params = new URLSearchParams(window.location.search);
    const y = Number(params.get("y"));
    const m = Number(params.get("m"));
    if (y >= 2000 && m >= 1 && m <= 12) {
      setYear(y);
      setMonth(m);
      return;
    }
    try {
      const saved = localStorage.getItem(storageKey(activeCompany.id));
      if (saved) {
        const [sy, sm] = saved.split("-").map(Number);
        if (sy >= 2000 && sm >= 1 && sm <= 12) {
          setYear(sy);
          setMonth(sm);
        }
      }
    } catch {
      /* localStorage puede no estar disponible (Safari privado) */
    }
  }, [activeCompany]);

  function setPeriod(y: number, m: number) {
    if (!(y >= 2000) || m < 1 || m > 12) return;
    setYear(y);
    setMonth(m);
    if (activeCompany) {
      try {
        localStorage.setItem(storageKey(activeCompany.id), `${y}-${m}`);
      } catch {
        /* ídem */
      }
    }
  }

  return (
    <PeriodContext.Provider
      value={{ year, month, setPeriod, label: `${MESES[month - 1]} ${year}` }}
    >
      {children}
    </PeriodContext.Provider>
  );
}

export function usePeriod() {
  return useContext(PeriodContext);
}

/** Selector global de período: pastilla ‹ Julio 2026 › en el header del flujo. */
export function PeriodSelector() {
  const { year, month, setPeriod, label } = usePeriod();

  function shift(delta: number) {
    const idx = (year * 12 + (month - 1)) + delta;
    setPeriod(Math.floor(idx / 12), (idx % 12) + 1);
  }

  return (
    <div className="inline-flex items-center rounded-control border border-cos-line bg-cos-card">
      <button
        onClick={() => shift(-1)}
        aria-label="Período anterior"
        className="px-2 py-1.5 text-cos-ink-soft hover:text-cos-ink hover:bg-cos-paper rounded-l-control"
      >
        ‹
      </button>
      <span className="px-2 font-mono text-[13px] font-medium text-cos-ink tabular-nums whitespace-nowrap">
        {label}
      </span>
      <button
        onClick={() => shift(1)}
        aria-label="Período siguiente"
        className="px-2 py-1.5 text-cos-ink-soft hover:text-cos-ink hover:bg-cos-paper rounded-r-control"
      >
        ›
      </button>
    </div>
  );
}
