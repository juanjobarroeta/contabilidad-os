"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Cumplimiento del hub de Nómina — obligaciones IMSS/INFONAVIT:
//   - Exportes SUA (bimestre) e IDSE (movimientos afiliatorios pendientes),
//     antes botones sueltos en el encabezado del workspace de corridas.
//   - Cuotas IMSS (SIPARE): estimado del periodo en curso y registro del pago.
//   - Validación del cálculo («nómina en paralelo») contra lo timbrado.
// La conciliación SUA (EMA/EBA) existe como API (/api/nomina/sua-reconciliation)
// pero aún no tiene interfaz — se integrará aquí cuando la tenga.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Download, Shield } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card } from "@/components/ui";
import ValidacionCalculo from "./ValidacionCalculo";
import ImssPagosCard from "./ImssPagosCard";

export default function CumplimientoTab() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [bimestre, setBimestre] = useState(Math.ceil((now.getMonth() + 1) / 2));
  const [year, setYear] = useState(now.getFullYear());

  if (!activeCompany) {
    return <div className="p-8 text-cos-ink-soft text-sm">Selecciona una empresa para ver su nómina.</div>;
  }

  const years = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7 space-y-5">
      <div>
        <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Cumplimiento</h1>
        <p className="mt-0.5 text-[14px] text-cos-ink-soft">IMSS, INFONAVIT y la validación del cálculo de tu nómina.</p>
      </div>

      {/* cuotas IMSS (SIPARE) */}
      <ImssPagosCard companyId={activeCompany.id} />

      {/* exportes SUA / IDSE */}
      <Card className="rounded-card border-cos-line p-5 shadow-card">
        <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Exportes IMSS</span>
        <p className="mt-2.5 mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
          Genera el archivo del bimestre para el <b className="text-cos-ink">SUA</b> (cuotas obrero-patronales e INFONAVIT)
          y el archivo <b className="text-cos-ink">IDSE</b> con los movimientos afiliatorios pendientes (altas, bajas y
          modificaciones de salario).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={bimestre} onChange={(e) => setBimestre(Number(e.target.value))}
            className="rounded-md border border-cos-line bg-cos-card px-2 py-2 text-sm"
            aria-label="Bimestre">
            {[1, 2, 3, 4, 5, 6].map((b) => (
              <option key={b} value={b}>Bimestre {b} ({["ene-feb", "mar-abr", "may-jun", "jul-ago", "sep-oct", "nov-dic"][b - 1]})</option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-md border border-cos-line bg-cos-card px-2 py-2 text-sm"
            aria-label="Ejercicio">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <a href={`/api/nomina/sua-export?companyId=${activeCompany.id}&bimestre=${bimestre}&year=${year}`}
            className="flex items-center gap-1.5 border border-cos-line px-3 py-2 rounded-md text-sm font-medium hover:bg-cos-paper" title="Exportar SUA">
            <Download className="h-4 w-4" /> Exportar SUA
          </a>
          <a href={`/api/nomina/imss-movimientos?companyId=${activeCompany.id}&format=idse&status=PENDING`}
            className="flex items-center gap-1.5 border border-cos-line px-3 py-2 rounded-md text-sm font-medium hover:bg-cos-paper" title="Exportar IDSE (movimientos pendientes)">
            <Shield className="h-4 w-4" /> Exportar IDSE
          </a>
        </div>
      </Card>

      {/* validación del cálculo (nómina en paralelo) — detalle completo */}
      <ValidacionCalculo companyId={activeCompany.id} />

      {/*
        Ajuste anual de ISR (Art. 97 LISR): la herramienta vive como página
        propia. Enlace listo para cuando se publique:
        <Link href="/nomina/ajuste-anual">Ajuste anual de ISR (Art. 97)</Link>
      */}
    </div>
  );
}
