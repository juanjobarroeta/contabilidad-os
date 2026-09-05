"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL WORKSPACE DEL CIERRE GUIADO — tres columnas: pasos (izquierda), el
// asistente (centro; en esta fase abre el drawer con el contexto del paso) y
// la evidencia con la decisión humana (derecha). En móvil se apilan.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageCircle, Sparkles } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { PeriodSelector, usePeriod } from "@/components/contabilidad/PeriodProvider";
import { ListaPasos } from "@/components/cierre/ListaPasos";
import { PanelEvidencia, type AccionPaso } from "@/components/cierre/PanelEvidencia";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import type { CierreEvaluado, PasoConDecision } from "@/lib/cierre/evaluar";
import { esClavePaso, type ClavePasoCierre } from "@/lib/cierre/claves";

function CierrePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeCompany } = useCompany();
  const { year, month, label, setPeriod } = usePeriod();
  const [cierre, setCierre] = useState<CierreEvaluado | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinPlan, setSinPlan] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const pasoParam = searchParams.get("paso");
  const [activo, setActivo] = useState<ClavePasoCierre | null>(esClavePaso(pasoParam) ? pasoParam : null);

  // ?y=&m= en la URL manda sobre el periodo guardado.
  useEffect(() => {
    const y = Number(searchParams.get("y"));
    const m = Number(searchParams.get("m"));
    if (y >= 2000 && m >= 1 && m <= 12 && (y !== year || m !== month)) setPeriod(y, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const companyId = activeCompany?.id;
  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cierre/estado?companyId=${companyId}&year=${year}&month=${month}`);
      if (res.status === 402) {
        setSinPlan(true);
        setCierre(null);
        return;
      }
      const j = (await res.json().catch(() => null)) as CierreEvaluado | { error?: string } | null;
      if (!res.ok || !j || !("pasos" in j)) throw new Error((j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      setSinPlan(false);
      setCierre(j);
    } catch {
      setCierre(null);
      setError("No se pudo cargar el cierre del periodo.");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Paso activo por default: el primero que necesita trabajo.
  const pasoActivo: PasoConDecision | null = useMemo(() => {
    if (!cierre) return null;
    const porClave = cierre.pasos.find((p) => p.clave === activo);
    if (porClave) return porClave;
    return (
      cierre.pasos.find((p) => p.estadoCalculado === "bloquea" || p.estadoCalculado === "atencion" || p.estado === "REVISAR") ??
      cierre.pasos.find((p) => p.estadoCalculado !== "no_aplica" && p.estado === "PENDIENTE") ??
      cierre.pasos[0] ??
      null
    );
  }, [cierre, activo]);

  function seleccionar(clave: ClavePasoCierre) {
    setActivo(clave);
    const params = new URLSearchParams(searchParams.toString());
    params.set("paso", clave);
    params.set("y", String(year));
    params.set("m", String(month));
    router.replace(`/cierre?${params.toString()}`);
  }

  async function decidir(accion: AccionPaso, nota: string | null) {
    if (!cierre || !pasoActivo || !companyId) return;
    setOcupado(true);
    setAviso(null);
    try {
      const res = await fetch("/api/cierre/paso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          year,
          month,
          clave: pasoActivo.clave,
          accion,
          hashEsperado: pasoActivo.hashEvidencia,
          nota,
        }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; cierre?: CierreEvaluado } | null;
      if (j?.cierre) setCierre(j.cierre);
      if (!res.ok) setAviso(j?.error ?? "No se pudo registrar la decisión.");
    } catch {
      setAviso("No se pudo registrar la decisión.");
    } finally {
      setOcupado(false);
    }
  }

  function abrirAsistente() {
    if (!pasoActivo) return;
    const senales = pasoActivo.senales
      .filter((s) => s.estado !== "ok" && s.estado !== "na")
      .map((s) => `- ${s.resumen}`)
      .join("\n");
    const seed =
      `Estoy en el cierre de ${label}, paso «${pasoActivo.titulo}» (${pasoActivo.estadoCalculado}).` +
      (senales ? `\nLo que el sistema detecta:\n${senales}` : "\nTodo en verde.") +
      `\n\n¿Qué reviso y en qué orden para dejar este paso listo?`;
    window.dispatchEvent(new CustomEvent("cos:ask-ai", { detail: { seed } }));
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-cos-ink-soft">Cierre guiado</p>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink">{activeCompany.razonSocial}</h1>
          <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
            {activeCompany.rfc}
            {cierre && (
              <>
                {" · "}
                {cierre.resumen.confirmados}/{cierre.resumen.aplican} pasos confirmados
                {cierre.resumen.bloquean > 0 && <span className="text-cos-red-ink"> · {cierre.resumen.bloquean} bloquea{cierre.resumen.bloquean === 1 ? "" : "n"}</span>}
                {cierre.resumen.completo && <span className="text-cos-jade-ink"> · listo para cerrar</span>}
              </>
            )}
          </p>
        </div>
        <PeriodSelector />
      </div>

      {sinPlan ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-6">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
            <Sparkles className="h-4 w-4 text-cos-brand" /> El cierre guiado es parte del plan Pro
          </p>
          <p className="mt-1 text-[13px] text-cos-ink-soft">
            El copiloto revisa cada día los doce pasos del cierre de esta empresa, te avisa lo que cambió y te acompaña hasta declarar.
            Actualiza el plan de la empresa para activarlo.
          </p>
        </div>
      ) : error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
          {error}
        </Alert>
      ) : loading || !cierre || !pasoActivo ? (
        <Loading label="Revisando el cierre del periodo…" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
          <aside className="rounded-card border border-cos-line bg-cos-card p-2">
            <ListaPasos pasos={cierre.pasos} activo={pasoActivo.clave} onSelect={seleccionar} />
          </aside>

          <section className="flex min-h-[320px] flex-col rounded-card border border-cos-line bg-cos-card">
            <div className="border-b border-cos-line px-4 py-3">
              <p className="text-[14px] font-semibold text-cos-ink">Copiloto · {pasoActivo.titulo}</p>
              <p className="text-[12px] text-cos-ink-soft">{pasoActivo.descripcion}</p>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
              <p className="max-w-md text-[13px] text-cos-ink-soft">
                {pasoActivo.detalle ?? "Sin pendientes en este paso."}
                {aviso && <span className="mt-2 block text-cos-red-ink">{aviso}</span>}
              </p>
              <button
                type="button"
                onClick={abrirAsistente}
                className={cn(
                  "inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep"
                )}
              >
                <MessageCircle className="h-4 w-4" /> Trabajar este paso con el copiloto
              </button>
              <p className="text-[11px] text-cos-ink-faint">
                El copiloto explica y propone; nada se ejecuta sin que lo confirmes.
              </p>
            </div>
          </section>

          <aside className="rounded-card border border-cos-line bg-cos-card p-4">
            <PanelEvidencia paso={pasoActivo} ocupado={ocupado} onDecidir={decidir} />
          </aside>
        </div>
      )}
    </div>
  );
}

export default function CierrePage() {
  return (
    <Suspense fallback={<Loading label="Cargando…" />}>
      <CierrePageInner />
    </Suspense>
  );
}
