"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Play, Pause, Trash2, Loader2, Repeat } from "lucide-react";
import { Button, Card, EmptyState } from "@/components/ui";
import { PERIODICIDAD_LABEL, type Periodicidad } from "@/lib/facturas/recurrentes";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña "Recurrentes" — la agenda de las series que generan prefacturas.
//
// Columnas tomadas de la pestaña Repeating de Xero y de los schedules de
// Remote: lo que se necesita saber de un vistazo es CADA CUÁNTO, CUÁNDO toca la
// siguiente y CUÁNTAS lleva. El importe va a la derecha con tabular-nums.
//
// La serie no timbra: genera un borrador y avisa. Eso se dice en la propia
// pantalla, porque es lo primero que alguien se pregunta al activar una.
// ─────────────────────────────────────────────────────────────────────────────

export interface SerieRecurrente {
  id: string;
  nombre: string;
  total: number;
  periodicidad: Periodicidad;
  diaMes: number;
  proximaEmision: string;
  fin: string | null;
  activa: boolean;
  generadas: number;
  ultimaEmision: string | null;
  customer: { razonSocial: string; rfc: string } | null;
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

function fmtFecha(iso: string): string {
  const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function RecurrentesView({
  companyId,
  onToast,
  onCambio,
}: {
  companyId: string;
  onToast: (m: string) => void;
  /** Cambió el número de series activas: el submenú refresca su insignia. */
  onCambio: () => void;
}) {
  const [series, setSeries] = useState<SerieRecurrente[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/facturas/recurrentes?companyId=${companyId}`);
      const d = await res.json();
      setSeries(Array.isArray(d.series) ? d.series : []);
    } catch {
      onToast("No se pudieron cargar las series recurrentes");
    } finally {
      setLoading(false);
    }
  }, [companyId, onToast]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function alternar(s: SerieRecurrente) {
    setBusy(s.id);
    try {
      const res = await fetch(`/api/facturas/recurrentes/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, activa: !s.activa }),
      });
      if (!res.ok) throw new Error();
      onToast(s.activa ? `«${s.nombre}» en pausa` : `«${s.nombre}» reactivada`);
      await cargar();
      onCambio();
    } catch {
      onToast("No se pudo cambiar el estado de la serie");
    } finally {
      setBusy(null);
    }
  }

  async function eliminar(s: SerieRecurrente) {
    if (
      !confirm(
        `¿Eliminar la serie «${s.nombre}»? Las prefacturas que ya generó se conservan; sólo deja de generar nuevas.`
      )
    )
      return;
    setBusy(s.id);
    try {
      const res = await fetch(`/api/facturas/recurrentes/${s.id}?companyId=${companyId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      onToast(`Serie «${s.nombre}» eliminada`);
      await cargar();
      onCambio();
    } catch {
      onToast("No se pudo eliminar la serie");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Card className="mt-4 rounded-card border-cos-line p-10 text-center shadow-card">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-cos-ink-faint" />
      </Card>
    );
  }

  if (series.length === 0) {
    return (
      <Card className="mt-4 rounded-card border-cos-line shadow-card">
        <EmptyState
          icon={Repeat}
          title="No tienes facturación recurrente"
          description="Para una renta o una iguala: al crear la factura elige «Guardar como recurrente» y el sistema dejará una prefactura lista en su fecha. Nunca timbra solo — sólo prepara el borrador para que lo revises."
          action={
            <Link href="/facturas/nueva">
              <Button variant="brand" size="md">
                <Plus className="h-4 w-4" /> Nueva factura
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <p className="mt-4 text-[13px] text-cos-ink-soft">
        Cada serie deja una <strong className="font-semibold">prefactura</strong> en su fecha —
        nunca timbra sola. Las encuentras en la pestaña Prefacturas para revisarlas y timbrarlas.
      </p>

      <Card className="mt-3 overflow-hidden rounded-card border-cos-line shadow-card">
        <div className="grid grid-cols-[minmax(0,1fr)_128px_120px_112px] gap-3 border-b border-cos-line px-[18px] py-3.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-cos-ink-faint max-[760px]:grid-cols-[minmax(0,1fr)_auto]">
          <span>Serie · cliente</span>
          <span className="max-[760px]:hidden">Cadencia</span>
          <span className="max-[760px]:hidden">Próxima</span>
          <span className="text-right">Importe</span>
        </div>

        {series.map((s) => (
          <div
            key={s.id}
            className="grid grid-cols-[minmax(0,1fr)_128px_120px_112px] items-center gap-3 border-b border-cos-line px-[18px] py-3 last:border-0 max-[760px]:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-[13.5px] font-medium text-cos-ink">
                {s.nombre}
                {!s.activa && (
                  <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-semibold text-cos-ink-soft">
                    En pausa
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[11.5px] text-cos-ink-faint">
                {s.customer?.razonSocial ?? "—"}
                {s.customer?.rfc ? ` · ${s.customer.rfc}` : ""}
                {s.generadas > 0 ? ` · ${s.generadas} generada${s.generadas === 1 ? "" : "s"}` : ""}
              </p>
              {/* En móvil las columnas del medio desaparecen: la cadencia baja aquí. */}
              <p className="hidden text-[11.5px] text-cos-ink-soft max-[760px]:block">
                {PERIODICIDAD_LABEL[s.periodicidad]}
                {s.activa ? ` · próxima ${fmtFecha(s.proximaEmision)}` : ""}
              </p>
            </div>

            <span className="text-[12.5px] text-cos-ink-soft max-[760px]:hidden">
              {PERIODICIDAD_LABEL[s.periodicidad]}
            </span>

            <span className="text-[12.5px] text-cos-ink-soft max-[760px]:hidden">
              {s.activa ? fmtFecha(s.proximaEmision) : "—"}
              {s.fin && (
                <span className="block text-[11px] text-cos-ink-faint">
                  hasta {fmtFecha(s.fin)}
                </span>
              )}
            </span>

            <div className="flex items-center justify-end gap-1">
              <span className="mr-1 font-mono text-[13.5px] font-semibold tabular-nums text-cos-ink">
                {fmtMoney(s.total)}
              </span>
              <button
                onClick={() => alternar(s)}
                disabled={busy === s.id}
                title={s.activa ? "Pausar la serie" : "Reactivar la serie"}
                aria-label={s.activa ? "Pausar la serie" : "Reactivar la serie"}
                className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-paper hover:text-cos-ink disabled:opacity-50"
              >
                {busy === s.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : s.activa ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => eliminar(s)}
                disabled={busy === s.id}
                title="Eliminar la serie"
                aria-label="Eliminar la serie"
                className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-red-tint hover:text-cos-red-ink disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}
