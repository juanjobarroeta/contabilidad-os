"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Money } from "@/components/ui";
import {
  Calculator, Loader2, CheckCircle2, AlertCircle, Save,
  FileText, TrendingUp, TrendingDown, Pencil, X,
} from "lucide-react";

type DecResult = {
  company: { rfc: string; razonSocial: string; regimenFiscal: string };
  tipoPersona: "PM" | "PF";
  ejercicio: number;
  totalIngresos: number;
  totalDeducciones: number;
  utilidadOPerdidaFiscal: number;
  perdidasAplicadas: number;
  resultadoFiscal: number;
  tasaIsr: number;
  isrDelEjercicio: number;
  isrAcreditable: number;
  isrAPagar: number;
  isrAFavor: number;
  coeficienteUtilidad: number | null;
  desglose: {
    ingresos: { porCfdis: number; otros: number; asimilados: number; ajusteInflacionAcumulable: number; total: number };
    deducciones: { compras: number; sueldos: number; cuotasImss: number; infonavitSar: number; depreciacion: number; ptu: number; ajusteInflacionDeducible: number; otras: number; total: number };
  };
  dataSources: Record<string, { monto: number; count?: string; sobreescritoManual?: boolean }>;
  existingDeclaration: { id: string; status: string } | null;
};

export default function DeclaracionAnualPage() {
  const { activeCompany } = useCompany();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear() - 1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DecResult | null>(null);
  const [error, setError] = useState("");
  const [editMode, setEditMode] = useState(false);

  // Manual overrides. `depreciacion` arranca vacío: cuando está vacío, la API
  // usa la depreciación calculada del registro de activo fijo; al escribir un
  // valor, lo sobreescribe.
  const [overrides, setOverrides] = useState({
    otrosIngresos: "0",
    depreciacion: "",
    otrasDeduccionesAutorizadas: "0",
    aportacionesInfonavitSar: "0",
    ajusteInflacionAcumulable: "0",
    ajusteInflacionDeducible: "0",
    perdidasAnteriores: "0",
    isrRetenidoPorTerceros: "0",
  });

  const loadDeclaracion = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      // Omitir overrides vacíos (p.ej. depreciacion) para que la API aplique su
      // default calculado en vez de un 0 que pisaría el registro.
      const overrideParams = Object.fromEntries(
        Object.entries(overrides).filter(([, v]) => v !== "")
      );
      const params = new URLSearchParams({
        companyId: activeCompany.id,
        ejercicio: String(ejercicio),
        ...overrideParams,
      });
      const res = await fetch(`/api/declaracion-anual?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, ejercicio, overrides]);

  useEffect(() => { loadDeclaracion(); }, [loadDeclaracion]);

  async function handleSave(status: "CALCULATED" | "FILED") {
    if (!activeCompany || !result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/declaracion-anual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          ejercicio,
          result,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      setError(`✓ Declaración ${status === "FILED" ? "marcada como presentada" : "guardada"}. CU ${result.coeficienteUtilidad ?? "N/A"} aplicado para ${ejercicio + 1}.`);
      loadDeclaracion();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Declaración Anual</h1>
          <p className="mt-1 text-[15px] text-cos-ink-soft">{activeCompany.razonSocial}</p>
          <a href="/declaraciones/historial" className="mt-1 inline-block text-[13px] text-cos-brand-ink hover:underline">
            Ver declaraciones mensuales →
          </a>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setEjercicio(e => e - 1)} className="rounded-control border border-cos-line px-3 py-1.5 text-sm hover:bg-cos-paper">←</button>
          <span className="min-w-[60px] text-center text-lg font-bold text-cos-ink">{ejercicio}</span>
          <button onClick={() => setEjercicio(e => e + 1)} className="rounded-control border border-cos-line px-3 py-1.5 text-sm hover:bg-cos-paper">→</button>
        </div>
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-control px-4 py-3 text-sm ${
          error.startsWith("✓") ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-red-tint text-cos-red-ink"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-soft">
          <Loader2 className="h-5 w-5 animate-spin" /> Calculando declaración anual...
        </div>
      ) : result && (
        <div className="space-y-5">
          {/* Header card */}
          <div className="rounded-card border border-cos-line bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-control ${
                  result.isrAPagar > 0 ? "bg-cos-red-tint" : "bg-cos-jade-tint"
                }`}>
                  {result.isrAPagar > 0
                    ? <TrendingDown className="h-5 w-5 text-cos-red-ink" />
                    : <TrendingUp className="h-5 w-5 text-cos-jade-ink" />}
                </div>
                <div>
                  <p className="font-semibold text-cos-ink">
                    {result.tipoPersona === "PM" ? "Persona Moral" : "Persona Física"} — Ejercicio {ejercicio}
                  </p>
                  <p className="text-xs text-cos-ink-soft">Régimen {result.company.regimenFiscal} · {result.company.rfc}</p>
                </div>
              </div>
              {result.existingDeclaration && (
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  result.existingDeclaration.status === "FILED" ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-brand-tint text-cos-brand-ink"
                }`}>
                  {result.existingDeclaration.status === "FILED" ? "Presentada" : "Calculada"}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-center sm:grid-cols-4">
              <Stat label="Ingresos" value={result.totalIngresos} />
              <Stat label="Deducciones" value={result.totalDeducciones} negative />
              <Stat label="Resultado fiscal" value={result.resultadoFiscal} />
              <Stat label={result.isrAPagar > 0 ? "ISR a pagar" : "ISR a favor"} value={result.isrAPagar > 0 ? result.isrAPagar : result.isrAFavor}
                negative={result.isrAPagar > 0} positive={result.isrAFavor > 0} />
            </div>
          </div>

          {/* Toggle manual overrides */}
          <button onClick={() => setEditMode(!editMode)}
            className="flex items-center gap-2 text-xs text-cos-brand-ink hover:underline">
            <Pencil className="h-3.5 w-3.5" />
            {editMode ? "Ocultar ajustes manuales" : "Ajustes manuales (depreciación, inflación, pérdidas...)"}
          </button>

          {editMode && (
            <div className="rounded-card border border-cos-amber-ink/20 bg-cos-amber-tint p-4">
              <p className="mb-3 text-xs font-medium text-cos-amber-ink">Ajustes manuales — estos campos no se calculan automáticamente</p>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ["otrosIngresos", "Otros ingresos (intereses, ganancia cambiaria)"],
                  ["depreciacion", "Depreciación de activos fijos"],
                  ["otrasDeduccionesAutorizadas", "Otras deducciones autorizadas"],
                  ["aportacionesInfonavitSar", "Aportaciones Infonavit / SAR patronal"],
                  ["ajusteInflacionAcumulable", "Ajuste anual por inflación acumulable"],
                  ["ajusteInflacionDeducible", "Ajuste anual por inflación deducible"],
                  ["perdidasAnteriores", "Pérdidas de ejercicios anteriores"],
                  ["isrRetenidoPorTerceros", "ISR retenido por terceros (clientes)"],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label className="mb-0.5 block text-[10px] font-medium text-cos-amber-ink">{label}</label>
                    <input type="number" step="0.01" value={overrides[key]}
                      onChange={e => setOverrides(p => ({ ...p, [key]: e.target.value }))}
                      className="w-full rounded-control border border-cos-amber-ink/30 bg-white px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cos-amber/30" />
                  </div>
                ))}
              </div>
              <button onClick={loadDeclaracion} className="mt-3 flex items-center gap-2 rounded-control bg-cos-amber-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                <Calculator className="h-3.5 w-3.5" /> Recalcular
              </button>
            </div>
          )}

          {/* Ingresos detail */}
          <Section title="Ingresos acumulables">
            <Row label="Ingresos por CFDIs emitidos" value={result.desglose.ingresos.porCfdis} />
            {result.desglose.ingresos.asimilados > 0 && <Row label="Asimilados a salarios (Art. 94)" value={result.desglose.ingresos.asimilados} />}
            {result.desglose.ingresos.otros > 0 && <Row label="Otros ingresos" value={result.desglose.ingresos.otros} />}
            {result.desglose.ingresos.ajusteInflacionAcumulable > 0 && <Row label="Ajuste anual por inflación acumulable" value={result.desglose.ingresos.ajusteInflacionAcumulable} />}
            <TotalRow label="Total ingresos" value={result.desglose.ingresos.total} />
          </Section>

          {/* Deducciones detail */}
          <Section title="Deducciones autorizadas">
            <Row label="Compras y gastos (CFDIs recibidos)" value={result.desglose.deducciones.compras} />
            <Row label="Sueldos y salarios" value={result.desglose.deducciones.sueldos} />
            {result.desglose.deducciones.cuotasImss > 0 && <Row label="Cuotas IMSS patronal" value={result.desglose.deducciones.cuotasImss} />}
            {result.desglose.deducciones.infonavitSar > 0 && <Row label="Aportaciones Infonavit / SAR" value={result.desglose.deducciones.infonavitSar} />}
            {result.desglose.deducciones.depreciacion > 0 && (
              <Row
                label={`Depreciación de inversiones${result.dataSources.depreciacionInversiones?.sobreescritoManual ? " (manual)" : ` (${result.dataSources.depreciacionInversiones?.count ?? "registro"})`}`}
                value={result.desglose.deducciones.depreciacion}
              />
            )}
            {result.desglose.deducciones.ptu > 0 && <Row label="PTU pagado" value={result.desglose.deducciones.ptu} />}
            {result.desglose.deducciones.ajusteInflacionDeducible > 0 && <Row label="Ajuste anual por inflación deducible" value={result.desglose.deducciones.ajusteInflacionDeducible} />}
            {result.desglose.deducciones.otras > 0 && <Row label="Otras deducciones" value={result.desglose.deducciones.otras} />}
            <TotalRow label="Total deducciones" value={result.desglose.deducciones.total} negative />
            {(result.dataSources.inversionesExcluidas?.monto ?? 0) > 0 && (
              <p className="mt-2 text-[11px] text-cos-ink-soft">
                Nota: {<Money value={result.dataSources.inversionesExcluidas.monto} className="text-[11px]" weight={400} />} de CFDIs de inversión NO se deducen como
                compra — se deducen vía depreciación (Art. 31/34). Revisa el registro en Activo fijo.
              </p>
            )}
            {(result.dataSources.sinEfectosExcluidos?.monto ?? 0) > 0 && (
              <p className="mt-1 text-[11px] text-cos-ink-soft">
                {<Money value={result.dataSources.sinEfectosExcluidos.monto} className="text-[11px]" weight={400} />} de CFDIs marcados “sin efectos fiscales” no son deducibles.
              </p>
            )}
          </Section>

          {/* Determinación del ISR */}
          <Section title="Determinación del ISR">
            <Row label="Utilidad / (pérdida) fiscal" value={result.utilidadOPerdidaFiscal} highlight={result.utilidadOPerdidaFiscal < 0} />
            {result.perdidasAplicadas > 0 && <Row label="Pérdidas de ejercicios anteriores aplicadas" value={-result.perdidasAplicadas} />}
            <Row label="Resultado fiscal" value={result.resultadoFiscal} bold />
            <Row label={`ISR del ejercicio (tasa ${(result.tasaIsr * 100).toFixed(result.tipoPersona === "PM" ? 0 : 2)}%)`} value={result.isrDelEjercicio} />
            <Row label="(-) ISR pagado en provisionales" value={-(result.dataSources.isrProvisionales?.monto ?? 0)} />
            {(result.dataSources.isrRetenidoAsimilados?.monto ?? 0) > 0 && (
              <Row label="(-) ISR que te retuvieron por asimilados" value={-(result.dataSources.isrRetenidoAsimilados?.monto ?? 0)} />
            )}
            {parseFloat(overrides.isrRetenidoPorTerceros) > 0 && (
              <Row label="(-) ISR retenido por terceros" value={-parseFloat(overrides.isrRetenidoPorTerceros)} />
            )}
            <div className="mt-2 border-t-2 border-cos-line pt-2">
              {result.isrAPagar > 0 ? (
                <TotalRow label="ISR A PAGAR" value={result.isrAPagar} negative />
              ) : (
                <TotalRow label="ISR A FAVOR" value={result.isrAFavor} positive />
              )}
            </div>
          </Section>

          {/* Coeficiente */}
          {result.coeficienteUtilidad != null && (
            <div className="rounded-card border border-cos-brand-ink/15 bg-cos-brand-tint p-4 text-sm text-cos-brand-ink">
              <p className="font-semibold">Coeficiente de utilidad para {ejercicio + 1}: <span className="font-mono">{result.coeficienteUtilidad.toFixed(4)}</span></p>
              <p className="mt-0.5 text-xs">Se aplicará automáticamente en los pagos provisionales de ISR del próximo ejercicio (Art. 14 LISR).</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button onClick={() => handleSave("CALCULATED")} disabled={saving}
              className="flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar cálculo
            </button>
            <button onClick={() => handleSave("FILED")} disabled={saving}
              className="flex items-center gap-2 rounded-control bg-cos-jade-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              <FileText className="h-4 w-4" />
              Marcar como presentada
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, negative, positive }: { label: string; value: number; negative?: boolean; positive?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-cos-ink-soft">{label}</p>
      <Money
        value={value}
        weight={700}
        className={`block break-words text-sm sm:text-base ${negative ? "text-cos-red-ink" : positive ? "text-cos-jade-ink" : "text-cos-ink"}`}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-cos-line bg-white p-5 shadow-card">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-cos-ink-soft">{title}</h3>
      <div className="space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function Row({ label, value, bold, highlight }: { label: string; value: number; bold?: boolean; highlight?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="text-cos-ink-soft">{label}</span>
      <Money value={value} weight={bold ? 600 : 400} className={highlight ? "text-cos-red-ink" : "text-cos-ink"} />
    </div>
  );
}

function TotalRow({ label, value, negative, positive }: { label: string; value: number; negative?: boolean; positive?: boolean }) {
  return (
    <div className="mt-1.5 flex justify-between border-t border-cos-line pt-1.5 font-bold">
      <span className="text-cos-ink">{label}</span>
      <Money value={value} weight={700} className={negative ? "text-cos-red-ink" : positive ? "text-cos-jade-ink" : "text-cos-ink"} />
    </div>
  );
}
