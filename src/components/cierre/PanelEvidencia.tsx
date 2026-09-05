"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Columna derecha del workspace: la evidencia del paso activo (cada señal con
// su cifra y su CTA) y la decisión humana: Confirmar / Omitir / Reabrir. La
// decisión viaja con el hash de la evidencia que el contador vio; si cambió,
// el servidor responde 409 y se recarga.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, TriangleAlert, Minus, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PasoConDecision } from "@/lib/cierre/evaluar";

const SENAL: Record<string, { Icon: typeof Check; clase: string }> = {
  ok: { Icon: Check, clase: "text-cos-jade-ink" },
  warn: { Icon: TriangleAlert, clase: "text-cos-amber-ink" },
  error: { Icon: TriangleAlert, clase: "text-cos-red-ink" },
  na: { Icon: Minus, clase: "text-cos-ink-faint" },
};

export type AccionPaso = "confirmar" | "omitir" | "reabrir";

export function PanelEvidencia({
  paso,
  ocupado,
  onDecidir,
}: {
  paso: PasoConDecision;
  ocupado: boolean;
  onDecidir: (accion: AccionPaso, nota: string | null) => Promise<void>;
}) {
  const [nota, setNota] = useState("");
  const [omitiendo, setOmitiendo] = useState(false);

  const decidido = paso.estado === "CONFIRMADO" || paso.estado === "OMITIDO";
  const puedeConfirmar = paso.requiereConfirmacion && (paso.estadoCalculado === "listo" || paso.estadoCalculado === "atencion");
  const bloqueado = paso.estadoCalculado === "bloquea" || paso.estadoCalculado === "espera";

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">Evidencia</p>
        <h2 className="mt-1 text-[17px] font-semibold text-cos-ink">{paso.titulo}</h2>
        <p className="text-[12.5px] text-cos-ink-soft">{paso.descripcion}</p>
        {paso.fechaLimite && (
          <p className={cn("mt-1 text-[12.5px]", (paso.diasRestantes ?? 0) < 0 ? "font-semibold text-cos-red-ink" : "text-cos-amber-ink")}>
            {(paso.diasRestantes ?? 0) < 0
              ? `Venció hace ${Math.abs(paso.diasRestantes ?? 0)} día(s) (${paso.fechaLimite})`
              : `Vence el ${paso.fechaLimite} · ${paso.diasRestantes} día(s)`}
          </p>
        )}
      </div>

      {paso.estadoCalculado === "no_aplica" ? (
        <p className="rounded-control bg-cos-slate-tint px-3 py-2 text-[12.5px] text-cos-ink-soft">Este paso no aplica a la empresa en este periodo.</p>
      ) : paso.senales.length === 0 ? (
        <p className="rounded-control bg-cos-slate-tint px-3 py-2 text-[12.5px] text-cos-ink-soft">{paso.detalle ?? "Sin señales todavía."}</p>
      ) : (
        <ul className="divide-y divide-cos-line-soft rounded-card border border-cos-line">
          {paso.senales.map((s) => {
            const pinta = SENAL[s.estado];
            return (
              <li key={s.clave} className="flex items-start gap-2 px-3 py-2">
                <pinta.Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", pinta.clase)} />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-cos-ink">{s.resumen}</p>
                  {s.cta && s.estado !== "ok" && (
                    <Link href={s.cta.href} className="inline-flex items-center gap-1 text-[11.5px] font-medium text-cos-brand-ink hover:underline">
                      {s.cta.label} <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {paso.estadoCalculado !== "no_aplica" && (
        <div className="rounded-card border border-cos-line bg-cos-paper p-3">
          {decidido ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-[12.5px] text-cos-ink">
                <Check className="h-3.5 w-3.5 text-cos-jade-ink" />
                {paso.estado === "CONFIRMADO" ? "Confirmado" : "Omitido"}
                {paso.confirmadoAt && <span className="text-cos-ink-faint">· {new Date(paso.confirmadoAt).toLocaleString("es-MX")}</span>}
              </p>
              {paso.nota && <p className="text-[12px] text-cos-ink-soft">«{paso.nota}»</p>}
              <button
                type="button"
                disabled={ocupado}
                onClick={() => onDecidir("reabrir", null)}
                className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-ink hover:bg-cos-card disabled:opacity-50"
              >
                Reabrir
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {paso.estado === "REVISAR" && (
                <p className="text-[12.5px] text-cos-amber-ink">La evidencia cambió desde la última confirmación. Revísala y vuelve a decidir.</p>
              )}
              {bloqueado && (
                <p className="flex items-center gap-2 text-[12.5px] text-cos-ink-soft">
                  <Lock className="h-3.5 w-3.5" />
                  {paso.estadoCalculado === "espera" ? "Un paso anterior bloquea éste." : "Hay un bloqueo activo: resuélvelo antes de confirmar."}
                </p>
              )}
              {omitiendo ? (
                <div className="space-y-2">
                  <textarea
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                    placeholder="Motivo para omitir este paso (queda en bitácora)"
                    rows={2}
                    className="w-full rounded-control border border-cos-line bg-cos-card px-2 py-1.5 text-[12.5px]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={ocupado || nota.trim().length === 0}
                      onClick={() => void onDecidir("omitir", nota.trim())}
                      className="rounded-control bg-cos-ink px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                    >
                      Omitir con motivo
                    </button>
                    <button type="button" onClick={() => setOmitiendo(false)} className="text-[12.5px] text-cos-ink-soft">
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={ocupado || !puedeConfirmar}
                    onClick={() => void onDecidir("confirmar", null)}
                    className="rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                  >
                    Confirmar paso
                  </button>
                  {paso.requiereConfirmacion && !bloqueado && (
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => setOmitiendo(true)}
                      className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-ink hover:bg-cos-card disabled:opacity-50"
                    >
                      Omitir
                    </button>
                  )}
                </div>
              )}
              <p className="text-[11px] text-cos-ink-faint">
                Confirmar guarda la evidencia de este momento. Si los datos cambian después, el paso vuelve a «revisar».
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
