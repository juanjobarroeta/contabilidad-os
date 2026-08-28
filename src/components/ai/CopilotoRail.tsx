"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL COPILOTO COMO RAIL, NO COMO CHAT ESCONDIDO.
//
// Decisión del rediseño Piloto (docs/REDISENO-PILOTO.md): lo que el copiloto
// SABE — los hallazgos del auditor fiscal, con severidad, sugerencia y
// fundamento — merece estar a la vista como CAJAS, no enterrado tras un botón
// flotante de chat. El rail vive en xl+ (colapsable a una tira con badge);
// «Preguntar al copiloto» abre el chat existente vía el evento cos:ask-ai —
// cero cirugía sobre ChatPanel. En pantallas menores el FAB de siempre sigue
// siendo la puerta.
//
// Tri-estado del fetch como en toda la casa: error con retry, vacío de
// verdad («sin hallazgos abiertos») sólo tras un 200.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronRight, ChevronLeft, MessageCircle, ShieldAlert, Sparkles, TriangleAlert, Info,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

interface HallazgoCard {
  id: string;
  categoria: string;
  severidad: string; // info | warn | error
  mensaje: string;
  sugerencia: string;
}

const SEV: Record<string, { Icon: typeof Info; chip: string }> = {
  error: { Icon: ShieldAlert, chip: "bg-cos-red-tint text-cos-red-ink" },
  warn: { Icon: TriangleAlert, chip: "bg-cos-amber-tint text-cos-amber-ink" },
  info: { Icon: Info, chip: "bg-cos-brand-tint text-cos-brand-ink" },
};

export function CopilotoRail() {
  const { activeCompany } = useCompany();
  const [colapsado, setColapsado] = useState(false);
  const [hallazgos, setHallazgos] = useState<HallazgoCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const companyId = activeCompany?.id;
  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/hallazgos?companyId=${companyId}&estado=ABIERTO`);
      const j = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j?.hallazgos ?? j)) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setHallazgos((j.hallazgos ?? j) as HallazgoCard[]);
    } catch {
      setHallazgos(null);
      setError("No se pudieron cargar los hallazgos.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!companyId) return null;

  const abiertos = hallazgos?.length ?? 0;
  const graves = hallazgos?.filter((h) => h.severidad === "error").length ?? 0;

  if (colapsado) {
    return (
      <aside className="hidden xl:flex w-12 flex-none flex-col items-center gap-3 border-l border-cos-line bg-cos-card py-4 print:hidden">
        <button
          type="button"
          onClick={() => setColapsado(false)}
          title="Abrir copiloto"
          className="rounded-control p-1.5 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="relative">
          <Sparkles className="h-5 w-5 text-cos-brand" />
          {abiertos > 0 && (
            <span
              className={cn(
                "absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                graves > 0 ? "bg-cos-red" : "bg-cos-amber",
              )}
            >
              {abiertos}
            </span>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="hidden xl:flex w-[300px] flex-none flex-col border-l border-cos-line bg-cos-card print:hidden">
      <div className="flex items-center justify-between border-b border-cos-line px-4 py-3">
        <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
          <Sparkles className="h-4 w-4 text-cos-brand" /> Copiloto
        </span>
        <button
          type="button"
          onClick={() => setColapsado(true)}
          title="Colapsar"
          className="rounded-control p-1 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {error && (
          <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
            {error}
          </Alert>
        )}
        {loading && !error && (
          <>
            <Skeleton className="h-20 rounded-card" />
            <Skeleton className="h-20 rounded-card" />
            <Skeleton className="h-20 rounded-card" />
          </>
        )}
        {!loading && !error && hallazgos && hallazgos.length === 0 && (
          <div className="rounded-card border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-3 text-[12.5px] text-cos-jade-ink">
            Sin hallazgos abiertos — el auditor no detectó riesgos pendientes en{" "}
            {activeCompany?.razonSocial}.
          </div>
        )}
        {!loading &&
          !error &&
          hallazgos?.slice(0, 8).map((h) => {
            const sev = SEV[h.severidad] ?? SEV.info;
            return (
              <Link
                key={h.id}
                href="/hallazgos"
                className="block rounded-card border border-cos-line bg-cos-paper px-3 py-2.5 transition-colors hover:border-cos-brand/40"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", sev.chip)}>
                    <sev.Icon className="h-3 w-3" /> {h.categoria}
                  </span>
                </div>
                <p className="text-[12.5px] font-medium leading-snug text-cos-ink">{h.mensaje}</p>
                {h.sugerencia && (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-cos-ink-soft">
                    {h.sugerencia}
                  </p>
                )}
              </Link>
            );
          })}
        {!loading && !error && abiertos > 8 && (
          <Link
            href="/hallazgos"
            className="block rounded-card px-3 py-2 text-center text-[12px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
          >
            Ver los {abiertos} hallazgos →
          </Link>
        )}
      </div>

      <div className="border-t border-cos-line p-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("cos:ask-ai"))}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep"
        >
          <MessageCircle className="h-3.5 w-3.5" /> Preguntar al copiloto
        </button>
      </div>
    </aside>
  );
}
