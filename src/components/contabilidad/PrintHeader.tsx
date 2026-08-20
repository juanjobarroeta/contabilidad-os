"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Encabezado de impresión de los reportes contables (brief módulo 5): invisible
// en pantalla, presente en papel. El contador externo que revisa con pluma
// necesita saber de qué empresa, qué período y cuándo se generó la hoja —
// sin eso, una balanza impresa es un papel huérfano.
//
// Título 16px seminegrita + línea de hechos en mono mayúsculas (idioma del
// deck): RAZÓN SOCIAL · RFC · PERÍODO · GENERADO <fecha es-MX>.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";

export function PrintHeader({
  title,
  periodo,
}: {
  /** Título del reporte tal como debe leerse en papel. */
  title: string;
  /** Anula la etiqueta de período global (p. ej. cuando el panel maneja su
   *  propio período, como Presentado CE). Sin él, usa usePeriod(). */
  periodo?: string;
}) {
  const { activeCompany } = useCompany();
  const { label } = usePeriod();
  // La fecha se calcula en efecto para no desincronizar SSR e hidratación
  // (zona horaria del servidor ≠ la del navegador).
  const [generado, setGenerado] = useState("");
  useEffect(() => {
    setGenerado(
      new Date().toLocaleDateString("es-MX", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    );
  }, []);

  return (
    <div className="hidden print:block mb-4 border-b border-cos-line pb-3">
      <h1 className="text-[16px] font-semibold leading-tight text-cos-ink">{title}</h1>
      <p className="mt-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-cos-ink-soft">
        {activeCompany?.razonSocial}
        {activeCompany?.rfc ? ` · RFC ${activeCompany.rfc}` : ""}
        {` · ${periodo ?? label}`}
        {generado ? ` · Generado ${generado}` : ""}
      </p>
    </div>
  );
}

/** Botón compartido «Imprimir»: dispara el diálogo de impresión del navegador.
 *  Mismo idioma visual que BotonExcel; invisible en el papel que produce. */
export function BotonImprimir() {
  return (
    <button
      onClick={() => window.print()}
      title="Imprimir el reporte"
      className="print:hidden inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-paper px-2.5 py-1.5 text-xs font-medium text-cos-ink hover:bg-cos-slate-tint"
    >
      <Printer className="h-3.5 w-3.5" /> Imprimir
    </button>
  );
}
