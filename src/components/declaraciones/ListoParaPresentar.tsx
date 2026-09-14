"use client";

// ─────────────────────────────────────────────────────────────────────────────
// «Listo para presentar» — el checklist del mes como UNA línea, no una tarjeta.
//
// La tarjeta de checklist abría la pestaña Resumen con diez renglones que
// repetían lo que Revisión ya lista como hallazgos y lo que Presentar ya
// exige. Lo que el contador necesita es una sola respuesta —¿puedo presentar?—
// y, si no, QUÉ falta, como chips que llevan a donde se arregla. Consume el
// mismo GET /api/declaraciones/checklist (que también lee el asistente).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle } from "lucide-react";

type Estado = "listo" | "pendiente" | "atencion" | "no-aplica";
interface Item { clave: string; titulo: string; estado: Estado; detalle: string; accionUrl?: string }
interface Data {
  diasRestantes: number;
  vencida: boolean;
  items: Item[];
  resumen: { listos: number; pendientes: number; atencion: number; noAplica: number; total: number };
}

export function ListoParaPresentar({ companyId, month, year }: { companyId: string; month: number; year: number }) {
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(async () => {
    setData(null);
    try {
      const res = await fetch(`/api/declaraciones/checklist?companyId=${companyId}&year=${year}&month=${month}`);
      if (res.ok) setData(await res.json());
    } catch { /* la línea simplemente no se muestra */ }
  }, [companyId, year, month]);
  useEffect(() => { load(); }, [load]);
  if (!data) return null;

  const porHacer = data.items.filter((i) => i.estado === "pendiente" || i.estado === "atencion");
  const aplicables = data.resumen.total - data.resumen.noAplica;
  const listo = porHacer.length === 0;
  const plazo = data.vencida
    ? "plazo vencido"
    : data.diasRestantes <= 0 ? "vence hoy" : `${data.diasRestantes} día${data.diasRestantes === 1 ? "" : "s"} para el plazo`;

  return (
    <div
      role="status"
      className={`mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border px-3.5 py-2 text-[12.5px] ${
        listo ? "border-cos-jade-ink/25 bg-cos-jade-tint/50" : "border-cos-amber/40 bg-cos-amber-tint/40"
      }`}
    >
      {listo ? (
        <span className="inline-flex items-center gap-1.5 font-semibold text-cos-jade-ink">
          <CheckCircle2 className="h-4 w-4" /> Listo para presentar
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-semibold text-cos-amber-ink">
          <AlertTriangle className="h-4 w-4" /> {porHacer.length} pendiente{porHacer.length === 1 ? "" : "s"} para presentar
        </span>
      )}
      <span className="text-cos-ink-faint tabular-nums">{data.resumen.listos} de {aplicables} · {plazo}</span>
      {porHacer.map((i) =>
        i.accionUrl ? (
          <Link
            key={i.clave}
            href={i.accionUrl}
            title={i.detalle}
            className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium hover:underline ${
              i.estado === "atencion" ? "bg-cos-amber-tint text-cos-amber-ink" : "bg-cos-card text-cos-ink-soft border border-cos-line"
            }`}
          >
            {i.titulo}
          </Link>
        ) : (
          <span key={i.clave} title={i.detalle} className="rounded-full border border-cos-line bg-cos-card px-2 py-0.5 text-[11.5px] text-cos-ink-soft">
            {i.titulo}
          </span>
        ),
      )}
    </div>
  );
}
