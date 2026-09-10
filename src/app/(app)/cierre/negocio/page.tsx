"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL MES PARA EL DUEÑO DEL NEGOCIO.
//
// Tres preguntas, en este orden: ¿vamos bien?, ¿cuánto voy a pagar?, ¿para
// cuándo?. Sin jerga y sin botones fiscales — quien no cierra el mes no lo
// firma. Los números son los MISMOS del motor: si aquí dice otra cosa que en la
// pantalla del contador, es un error, no una simplificación.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, Clock, Sparkles } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { PeriodSelector, usePeriod } from "@/components/contabilidad/PeriodProvider";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { resumenNegocio } from "@/lib/cierre/negocio";
import type { CierreEvaluado } from "@/lib/cierre/evaluar";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function pesos(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
}

function NegocioInner() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  const [cierre, setCierre] = useState<CierreEvaluado | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinPlan, setSinPlan] = useState(false);

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
      const j = (await res.json().catch(() => null)) as CierreEvaluado | null;
      if (!res.ok || !j || !("pasos" in j)) throw new Error("error");
      setSinPlan(false);
      setCierre(j);
    } catch {
      setCierre(null);
      setError("No se pudo cargar el estado del mes.");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const r = useMemo(() => (cierre ? resumenNegocio(cierre) : null), [cierre]);

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;

  const mes = `${MESES[month - 1]} de ${year}`;

  return (
    <div className="mx-auto flex h-full max-w-[720px] flex-col gap-3 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] text-cos-ink-soft">Cómo va tu {mes}</p>
          <h1 className="line-clamp-2 text-[19px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink sm:text-[23px]">
            {activeCompany.razonSocial}
          </h1>
        </div>
        <PeriodSelector />
      </div>

      {sinPlan ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-6">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
            <Sparkles className="h-4 w-4 text-cos-brand" /> Esta vista es parte del plan Pro
          </p>
        </div>
      ) : error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
          {error}
        </Alert>
      ) : loading || !r ? (
        <Loading label="Revisando tu mes…" />
      ) : (
        <>
          {/* ¿Vamos bien? */}
          <section
            className={`rounded-card border p-5 ${
              r.detienen > 0
                ? "border-cos-red-ink/30 bg-cos-red-tint"
                : r.alDia
                  ? "border-cos-jade-ink/30 bg-cos-jade-tint"
                  : "border-cos-amber-ink/30 bg-cos-amber-tint"
            }`}
          >
            <p className="flex items-center gap-2 text-[17px] font-semibold leading-snug text-cos-ink sm:text-[20px]">
              {r.cerradoFueraDeContabilidadOS ? (
                <>
                  <Check className="h-5 w-5 shrink-0 text-cos-jade-ink" /> Declarado · cerrado fuera de ContabilidadOS.
                </>
              ) : r.alDia ? (
                <>
                  <Check className="h-5 w-5 shrink-0 text-cos-jade-ink" /> Tu {mes} está al corriente.
                </>
              ) : r.detienen > 0 ? (
                <>
                  <AlertTriangle className="h-5 w-5 shrink-0 text-cos-red-ink" /> Hay algo que detiene el cierre de tu {mes}.
                </>
              ) : (
                <>
                  <Clock className="h-5 w-5 shrink-0 text-cos-amber-ink" /> Tu {mes} va avanzando, faltan detalles.
                </>
              )}
            </p>
            <p className="mt-1.5 text-[13.5px] text-cos-ink">
              {r.cerradoFueraDeContabilidadOS
                ? "Conservamos la declaración histórica como el punto de partida de la empresa."
                : `${r.listos} de ${r.total} partes del mes están listas.`}
            </p>
          </section>

          {/* ¿Cuánto voy a pagar? */}
          <section className="rounded-card border border-cos-line bg-cos-card p-5">
            <p className="text-[13px] font-medium text-cos-ink">Lo que sale a pagar de este mes</p>
            {r.aPagar ? (
              <>
                <div className="mt-2 flex flex-wrap gap-6">
                  <div>
                    <p className="text-[12px] text-cos-ink-soft">IVA</p>
                    <p className="font-mono text-[20px] font-semibold text-cos-ink">
                      {r.aPagar.iva == null ? "—" : pesos(r.aPagar.iva)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[12px] text-cos-ink-soft">ISR</p>
                    <p className="font-mono text-[20px] font-semibold text-cos-ink">
                      {r.aPagar.isr == null ? "—" : pesos(r.aPagar.isr)}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-[12px] text-cos-ink-soft">
                  Calculado con lo que hay registrado hoy. Si todavía faltan facturas o movimientos del banco, la cifra puede
                  moverse.
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-[13px] text-cos-ink-soft">
                Todavía no se puede calcular: falta cerrar partes del mes. Cuando estén, aquí aparece la cifra.
              </p>
            )}
          </section>

          {/* ¿Para cuándo? */}
          {r.fechaLimite && (
            <section className="rounded-card border border-cos-line bg-cos-card p-5">
              <p className="text-[13px] font-medium text-cos-ink">Fecha límite para declarar</p>
              <p className="mt-1 text-[15px] text-cos-ink">
                {r.fechaLimite}
                {r.diasRestantes != null && (
                  <span className={r.diasRestantes < 0 ? "text-cos-red-ink" : "text-cos-ink-soft"}>
                    {r.diasRestantes < 0
                      ? ` · venció hace ${Math.abs(r.diasRestantes)} días`
                      : ` · faltan ${r.diasRestantes} días`}
                  </span>
                )}
              </p>
              {r.declarado ? (
                <p className="mt-1 text-[12.5px] text-cos-jade-ink">Ya está presentada.</p>
              ) : (
                <p className="mt-1 text-[12.5px] text-cos-ink-soft">
                  Después de esa fecha el SAT cobra recargos, aunque no salga nada a pagar.
                </p>
              )}
            </section>
          )}

          {/* ¿Qué falta? */}
          {r.falta.length > 0 && (
            <section className="rounded-card border border-cos-line bg-cos-card p-5">
              <p className="text-[13px] font-medium text-cos-ink">Lo que falta</p>
              <ul className="mt-2 space-y-1.5">
                {r.falta.map((f) => (
                  <li key={f.hacer} className="flex items-start gap-2 text-[13.5px] text-cos-ink">
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        f.detiene ? "bg-cos-red-ink" : "bg-cos-amber-ink"
                      }`}
                    />
                    <span>
                      {f.hacer}
                      {f.detiene && <span className="text-cos-red-ink"> · detiene el cierre</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-cos-ink-soft">De esto se encarga quien lleva tu contabilidad.</p>
            </section>
          )}

          <Link
            href={`/cierre?y=${year}&m=${month}`}
            className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-cos-ink-soft hover:text-cos-ink"
          >
            Ver el detalle contable <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </>
      )}
    </div>
  );
}

export default function NegocioPage() {
  return (
    <Suspense fallback={<Loading label="Cargando…" />}>
      <NegocioInner />
    </Suspense>
  );
}
