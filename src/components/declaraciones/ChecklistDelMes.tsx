"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";
import { CheckCircle2, AlertTriangle, Circle, Minus, ChevronRight, ChevronDown } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist del mes — "¿qué necesito para mi declaración?" en una tarjeta
// compacta dentro de la pestaña "Del mes". Consume
// GET /api/declaraciones/checklist (misma estructura que usa el asistente).
// Colapsable: si todo está listo se muestra plegada; con pendientes, abierta.
// ─────────────────────────────────────────────────────────────────────────────

type ChecklistEstado = "listo" | "pendiente" | "atencion" | "no-aplica";
interface ChecklistItem {
  clave: string;
  titulo: string;
  estado: ChecklistEstado;
  detalle: string;
  accionUrl?: string;
}
interface ChecklistData {
  periodo: string;
  fechaLimite: string;
  diasRestantes: number;
  vencida: boolean;
  items: ChecklistItem[];
  resumen: { listos: number; pendientes: number; atencion: number; noAplica: number; total: number };
}

function EstadoIcono({ estado }: { estado: ChecklistEstado }) {
  switch (estado) {
    case "listo":
      return <CheckCircle2 className="h-4 w-4 flex-none text-cos-jade-ink" aria-label="Listo" />;
    case "atencion":
      return <AlertTriangle className="h-4 w-4 flex-none text-cos-amber-ink" aria-label="Atención" />;
    case "pendiente":
      return <Circle className="h-4 w-4 flex-none text-cos-ink-faint" aria-label="Pendiente" />;
    case "no-aplica":
      return <Minus className="h-4 w-4 flex-none text-cos-ink-faint" aria-label="No aplica" />;
  }
}

export function ChecklistDelMes({ companyId, month, year }: { companyId: string; month: number; year: number }) {
  const [data, setData] = useState<ChecklistData | null>(null);
  const [abierto, setAbierto] = useState<boolean | null>(null); // null = aún sin decidir

  const load = useCallback(async () => {
    setData(null);
    setAbierto(null);
    try {
      const res = await fetch(`/api/declaraciones/checklist?companyId=${companyId}&year=${year}&month=${month}`);
      if (!res.ok) return;
      const d: ChecklistData = await res.json();
      setData(d);
      // Plegada cuando todo está listo; abierta si hay algo que hacer.
      setAbierto(d.resumen.pendientes + d.resumen.atencion > 0);
    } catch {
      /* silencioso: la tarjeta simplemente no se muestra */
    }
  }, [companyId, year, month]);

  useEffect(() => { load(); }, [load]);

  if (!data) return null;

  const porHacer = data.resumen.pendientes + data.resumen.atencion;
  const aplicables = data.resumen.total - data.resumen.noAplica;
  const expandida = abierto ?? porHacer > 0;

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <button
        onClick={() => setAbierto(!expandida)}
        aria-expanded={expandida}
        className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint rounded"
      >
        <div className="flex items-center gap-2">
          <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
            Checklist del mes
          </span>
          {porHacer > 0 ? (
            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-cos-amber-tint px-1 text-[11px] font-semibold text-cos-amber-ink">
              {porHacer}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-cos-jade-tint px-2 py-0.5 text-[11px] font-semibold text-cos-jade-ink">
              <CheckCircle2 className="h-3 w-3" /> Todo listo
            </span>
          )}
        </div>
        <span className="inline-flex items-center gap-2 text-[12.5px] text-cos-ink-soft">
          {data.resumen.listos} de {aplicables} listos
          <ChevronDown className={`h-4 w-4 transition-transform ${expandida ? "" : "-rotate-90"}`} />
        </span>
      </button>

      {expandida && (
        <ul className="mt-3 divide-y divide-cos-line-soft">
          {data.items.map((item) => {
            const fila = (
              <div className={`flex items-start gap-2.5 py-2 ${item.estado === "no-aplica" ? "opacity-60" : ""}`}>
                <span className="mt-0.5"><EstadoIcono estado={item.estado} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-cos-ink">{item.titulo}</p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-cos-ink-soft">{item.detalle}</p>
                </div>
                {item.accionUrl && item.estado !== "no-aplica" && (
                  <ChevronRight className="mt-1 h-3.5 w-3.5 flex-none text-cos-ink-faint" />
                )}
              </div>
            );
            return (
              <li key={item.clave}>
                {item.accionUrl && item.estado !== "no-aplica" ? (
                  <Link
                    href={item.accionUrl}
                    className="block rounded hover:bg-cos-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint"
                  >
                    {fila}
                  </Link>
                ) : (
                  fila
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
