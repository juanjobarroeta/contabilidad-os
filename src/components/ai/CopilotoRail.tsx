"use client";

// ─────────────────────────────────────────────────────────────────────────────
// COPILOTO v2 — cartas-VERBO, no enunciados (feedback del owner con 97
// hallazgos reales: «me estresa y no hay camino»).
//
//   · Los hallazgos se AGRUPAN por causa raíz operativa (el destino que los
//     resuelve): 4 obligaciones vencidas = UNA carta con contador. Máximo 4
//     grupos; error > warn; los `info` colapsan a una línea.
//   · El botón principal de cada carta ES la sugerencia: deep link al lugar
//     donde se arregla (ctaParaHallazgo). La prosa pasa a segundo plano.
//   · Posponer 7 días inline (PATCH existente, en lote) — la pila ENCOGE.
//   · Con cartera de 2+ empresas: resumen agregado arriba, enlazando a la
//     vista de Cartera.
//
// Tri-estado del fetch como en toda la casa.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, Briefcase, ChevronRight, ChevronLeft, Clock, MessageCircle, ShieldAlert,
  Sparkles, TriangleAlert,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { agruparParaRail, type HallazgoRail, type RailAgrupado } from "@/lib/hallazgos/agrupar";
import { cn } from "@/lib/utils";

interface Cartera {
  empresas: number;
  total: number;
  criticos: number;
}

export function CopilotoRail() {
  const { activeCompany, companies } = useCompany();
  const [colapsado, setColapsado] = useState(false);
  const [rail, setRail] = useState<RailAgrupado | null>(null);
  const [cartera, setCartera] = useState<Cartera | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posponiendo, setPosponiendo] = useState<string | null>(null);

  const companyId = activeCompany?.id;
  const multi = companies.length > 1;

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [res, resCartera] = await Promise.all([
        fetch(`/api/hallazgos?companyId=${companyId}&estado=ABIERTO`),
        multi ? fetch("/api/hallazgos/cartera") : Promise.resolve(null),
      ]);
      const j = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j?.hallazgos)) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setRail(agruparParaRail(j.hallazgos as HallazgoRail[]));
      if (resCartera?.ok) setCartera((await resCartera.json()) as Cartera);
    } catch {
      setRail(null);
      setError("No se pudieron cargar los hallazgos.");
    } finally {
      setLoading(false);
    }
  }, [companyId, multi]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function posponer(grupoHref: string, ids: string[]) {
    setPosponiendo(grupoHref);
    try {
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/hallazgos/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ posponer: "7d" }),
          }),
        ),
      );
      await cargar(); // la pila encoge de verdad
    } finally {
      setPosponiendo(null);
    }
  }

  if (!companyId) return null;

  const abiertos = rail ? rail.grupos.reduce((t, g) => t + g.count, 0) + rail.restantes : 0;
  const graves = rail?.grupos.filter((g) => g.severidad === "error").length ?? 0;

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
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
          </>
        )}

        {!loading && !error && cartera && cartera.total > 0 && (
          <Link
            href="/despacho"
            className="block rounded-card border border-cos-brand/25 bg-cos-brand-tint px-3 py-2.5 transition-colors hover:border-cos-brand/50"
          >
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-cos-brand-ink">
              <Briefcase className="h-3.5 w-3.5" /> Tu cartera
            </p>
            <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
              {cartera.total} hallazgo{cartera.total === 1 ? "" : "s"} en {cartera.empresas} empresa
              {cartera.empresas === 1 ? "" : "s"}
              {cartera.criticos > 0 && (
                <span className="font-semibold text-cos-red-ink"> · {cartera.criticos} críticos</span>
              )}{" "}
              — ver por empresa →
            </p>
          </Link>
        )}

        {!loading && !error && rail && rail.grupos.length === 0 && (
          <div className="rounded-card border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-3 text-[12.5px] text-cos-jade-ink">
            {activeCompany?.razonSocial}: sin pendientes urgentes del auditor.
            {rail.informativos > 0 &&
              ` ${rail.informativos} ${rail.informativos === 1 ? "aviso informativo" : "avisos informativos"} en Hallazgos.`}
          </div>
        )}

        {!loading &&
          !error &&
          rail?.grupos.map((g) => (
            <div
              key={g.href + g.categoria}
              className="rounded-card border border-cos-line bg-cos-paper px-3 py-2.5"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    g.severidad === "error"
                      ? "bg-cos-red-tint text-cos-red-ink"
                      : "bg-cos-amber-tint text-cos-amber-ink",
                  )}
                >
                  {g.severidad === "error" ? (
                    <ShieldAlert className="h-3 w-3" />
                  ) : (
                    <TriangleAlert className="h-3 w-3" />
                  )}
                  {g.categoria}
                </span>
                {g.count > 1 && (
                  <span className="rounded-full bg-cos-slate-tint px-1.5 text-[10.5px] font-bold tabular-nums text-cos-ink-soft">
                    {g.count}
                  </span>
                )}
              </div>
              <p className="text-[13px] font-semibold leading-snug text-cos-ink">{g.titulo}</p>
              {g.muestra && (
                <p className="mt-0.5 line-clamp-1 text-[11.5px] text-cos-ink-faint">p. ej. {g.muestra}</p>
              )}
              <div className="mt-2 flex items-center gap-1.5">
                <Link
                  href={g.href}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-control bg-cos-brand px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-cos-brand-deep"
                >
                  {g.verbo} <ArrowRight className="h-3 w-3" />
                </Link>
                <button
                  type="button"
                  title="Posponer 7 días"
                  disabled={posponiendo !== null}
                  onClick={() => posponer(g.href, g.ids)}
                  className="rounded-control border border-cos-line p-1.5 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink disabled:opacity-50"
                >
                  <Clock className={cn("h-3.5 w-3.5", posponiendo === g.href && "animate-pulse")} />
                </button>
              </div>
            </div>
          ))}

        {!loading && !error && rail && (rail.restantes > 0 || rail.informativos > 0) && (
          <Link
            href="/hallazgos"
            className="block rounded-card px-3 py-2 text-center text-[12px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
          >
            {[
              rail.restantes > 0 ? `${rail.restantes} más` : null,
              rail.informativos > 0 ? `${rail.informativos} informativos` : null,
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            → Ver todos
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
