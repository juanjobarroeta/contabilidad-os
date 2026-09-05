"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /cierre — el workspace del cierre guiado (PRO). Monta el mismo
// PeriodProvider que el flujo contable (misma storageKey por empresa: el
// periodo elegido se comparte entre secciones) y lee ?y=&m= de la URL.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { PeriodProvider } from "@/components/contabilidad/PeriodProvider";

export default function CierreLayout({ children }: { children: ReactNode }) {
  return <PeriodProvider>{children}</PeriodProvider>;
}
