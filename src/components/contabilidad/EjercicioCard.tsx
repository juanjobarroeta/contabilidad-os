"use client";

// La tarjeta del ejercicio: traspaso del resultado a acumulados, cierre
// definitivo (protege los asientos del año) y reapertura con bitácora.
// Extraída del monolito de contabilidad; vive en el Cierre del mes.

import { useState } from "react";
import { Calendar, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { evaluarCierreEjercicio } from "@/lib/contabilidad/ejercicio";
import { formatCurrency } from "@/lib/utils";
import type { Period } from "@/components/contabilidad/ContabilidadElectronicaPanel";

export
function EjercicioCard({
  companyId, year, periods, onReload,
}: {
  companyId: string;
  year: number;
  periods: Period[];
  onReload: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"cerrar" | "reabrir" | "traspaso" | null>(null);
  const [msg, setMsg] = useState<{ texto: string; error: boolean } | null>(null);

  const delAnio = periods.filter((p) => p.year === year);
  const ev = evaluarCierreEjercicio(delAnio);
  // El traspaso vive en el mes 1 del año siguiente, así que sólo tiene sentido
  // ofrecerlo cuando ya existe el asiento de cierre de este ejercicio.
  const puedeTraspasar = !ev.faltaCierre;

  async function accion(tipo: "cerrar" | "reabrir" | "traspaso") {
    if (tipo === "cerrar" && !confirm(
      `¿Cerrar el ejercicio ${year}? A partir de ese momento ningún proceso podrá modificar sus asientos: ni el re-posteo automático, ni la conciliación bancaria, ni las pólizas manuales. Siempre puedes reabrirlo (queda registrado en la bitácora).`
    )) return;
    if (tipo === "reabrir" && !confirm(
      `¿Reabrir el ejercicio ${year}? Los periodos vuelven a admitir cambios. La acción queda registrada en la bitácora.`
    )) return;

    setBusy(tipo);
    setMsg(null);
    try {
      const url = tipo === "traspaso" ? "/api/contabilidad/traspaso" : "/api/contabilidad/ejercicio";
      const body = tipo === "traspaso"
        ? { companyId, year }
        : { companyId, year, accion: tipo };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo completar la operación");

      if (tipo === "traspaso") {
        const r = data.resultado as number;
        setMsg({
          texto: r === 0
            ? `El ejercicio ${year} cerró en ceros: no hay resultado que traspasar.`
            : `Traspasado a resultados acumulados: ${r >= 0 ? "utilidad" : "pérdida"} de ${formatCurrency(Math.abs(r))} con fecha 1-ene-${data.ejercicioDestino}.`,
          error: false,
        });
      } else if (tipo === "cerrar") {
        setMsg({ texto: `Ejercicio ${year} cerrado. Sus asientos quedan protegidos.`, error: false });
      } else {
        setMsg({
          texto: `Ejercicio ${year} reabierto (${data.reabiertos} ${data.reabiertos === 1 ? "periodo" : "periodos"}).`,
          error: false,
        });
      }
      await onReload();
    } catch (e) {
      setMsg({ texto: e instanceof Error ? e.message : "Error", error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`mb-4 rounded-xl border p-4 ${
      ev.yaCerrado
        ? "border-[oklch(0.66_0.12_168_/_0.35)] bg-cos-jade-tint"
        : "border-cos-line bg-cos-card"
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-semibold text-cos-ink">
            {ev.yaCerrado ? <ShieldCheck className="h-4 w-4 text-cos-jade-ink" /> : <Calendar className="h-4 w-4 text-cos-ink-soft" />}
            Ejercicio {year}
            {ev.yaCerrado && (
              <span className="rounded bg-cos-jade-tint px-2 py-0.5 text-xs font-medium text-cos-jade-ink">Cerrado</span>
            )}
          </p>
          <p className="mt-1 max-w-[68ch] text-xs text-cos-ink-soft">
            {ev.yaCerrado
              ? "Ningún proceso puede modificar los asientos de este año: ni el re-posteo automático, ni la conciliación, ni las pólizas manuales. Reábrelo si necesitas corregir algo."
              : ev.motivo ?? "El ejercicio está listo para cerrarse. Traspasa el resultado a acumulados y ciérralo para proteger sus asientos."}
          </p>
        </div>
        <div className="flex flex-none flex-wrap gap-2">
          {!ev.yaCerrado && (
            <button
              onClick={() => accion("traspaso")}
              disabled={busy !== null || !puedeTraspasar}
              title={puedeTraspasar
                ? `Traspasa el resultado de ${year} de «Utilidad del ejercicio» (305.01) a «Utilidad de ejercicios anteriores» (304.01), con fecha 1-ene-${year + 1}`
                : `Genera primero el asiento de cierre de ${year} (botón «Cierre ${year}» arriba)`}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {busy === "traspaso" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Traspasando…</> : "Traspasar resultado"}
            </button>
          )}
          {ev.yaCerrado ? (
            <button
              onClick={() => accion("reabrir")}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {busy === "reabrir" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reabriendo…</> : <><RotateCcw className="h-3.5 w-3.5" /> Reabrir ejercicio</>}
            </button>
          ) : (
            <button
              onClick={() => accion("cerrar")}
              disabled={busy !== null || !ev.puedeCerrar}
              title={ev.puedeCerrar ? `Cierra definitivamente el ejercicio ${year}` : ev.motivo ?? ""}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {busy === "cerrar" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cerrando…</> : <><ShieldCheck className="h-3.5 w-3.5" /> Cerrar ejercicio</>}
            </button>
          )}
        </div>
      </div>
      {msg && (
        <p className={`mt-2.5 text-xs ${msg.error ? "text-cos-red-ink" : "text-cos-jade-ink"}`}>
          {msg.error ? "" : "✓ "}{msg.texto}
        </p>
      )}
    </div>
  );
}
