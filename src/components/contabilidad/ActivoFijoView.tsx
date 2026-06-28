"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Activo fijo — registro de inversiones y su tabla de depreciación (Art. 31/34).
// Phase 2a: muestra el cálculo de la deducción por depreciación del ejercicio.
// Todavía NO alimenta el ISR (eso es la Fase 2b: excluir la inversión de las
// deducciones inmediatas y sumar esta depreciación, en un solo cambio).
//
// <ActivoFijoView /> es el cuerpo reutilizable: se renderiza como pestaña dentro
// del hub de Contabilidad (/contabilidad?tab=activo-fijo) y, como respaldo, en
// la ruta /activos (hoy redirigida a esa pestaña). No incluye el encabezado de
// página: lo aporta el contenedor.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Info, X } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading, Money } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

const TIPO_LABEL: Record<string, string> = {
  construccion: "Construcción (5%)",
  mobiliario: "Mobiliario y equipo (10%)",
  transporte: "Equipo de transporte (25%)",
  computo: "Equipo de cómputo (30%)",
  herramental: "Dados, troqueles, moldes (35%)",
  comunicaciones: "Comunicaciones (10%)",
  maquinaria: "Maquinaria y equipo (10%)",
  otro: "Otro (10%)",
};

interface ActivoRow {
  id: string;
  descripcion: string;
  tipo: string;
  moi: number;
  fechaAdquisicion: string;
  esAutomovil: boolean;
  esElectricoHibrido: boolean;
  fechaBaja: string | null;
  autoCreado: boolean;
  invoice: { uuid: string | null; serie: string | null; folio: string | null } | null;
  depreciacion: {
    moiDeducible: number;
    topeAplicado: boolean;
    tasaAnual: number;
    mesesUsoEjercicio: number;
    depreciacionNominalEjercicio: number;
    depreciacionEjercicio: number;
    depreciacionAcumuladaPrevia: number;
    saldoPendiente: number;
    factorActualizacion: number;
    sinActualizar: boolean;
    tasaAproximada: boolean;
    actualizacion: { completo: boolean };
  };
}

export function ActivoFijoView() {
  const { activeCompany } = useCompany();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear());
  const [data, setData] = useState<{ activos: ActivoRow[]; totalDepreciacionEjercicio: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/activos?companyId=${activeCompany.id}&ejercicio=${ejercicio}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [activeCompany, ejercicio]);

  useEffect(() => { load(); }, [load]);

  async function eliminar(id: string) {
    if (!confirm("¿Eliminar este activo del registro?")) return;
    await fetch(`/api/activos/${id}`, { method: "DELETE" });
    load();
  }

  if (!activeCompany) return <Loading />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[14px] text-cos-ink-soft">
          Inversiones que se deducen vía depreciación (Art. 31/34 LISR), no de golpe.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={ejercicio}
            onChange={(e) => setEjercicio(parseInt(e.target.value))}
            className="rounded-control border border-cos-line bg-white px-3 py-2 text-[14px]"
          >
            {[0, 1, 2, 3].map((d) => {
              const y = new Date().getFullYear() - d;
              return <option key={y} value={y}>Ejercicio {y}</option>;
            })}
          </select>
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-[14px] font-semibold text-white hover:bg-cos-brand-deep"
          >
            <Plus className="h-4 w-4" /> Alta manual
          </button>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : !data || data.activos.length === 0 ? (
        <div className="mt-6 rounded-card border border-dashed border-cos-line bg-white px-6 py-12 text-center text-[14px] text-cos-ink-soft">
          Sin activos en el registro. Da de alta uno, o desde una factura de inversión
          (naturaleza “Activo fijo”) usa <b>“Registrar como activo fijo”</b>.
        </div>
      ) : (
        <>
          <div className="mt-5 flex items-center justify-between rounded-card bg-cos-brand-tint px-5 py-4">
            <span className="text-[14px] text-cos-brand-ink">Depreciación deducible del ejercicio {ejercicio}</span>
            <span className="font-mono text-[20px] font-bold text-cos-brand-ink">{formatCurrency(data.totalDepreciacionEjercicio)}</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-card border border-cos-line bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Activo</th>
                  <th className="px-3 py-2.5 text-right font-medium">MOI</th>
                  <th className="px-3 py-2.5 text-right font-medium">Tasa</th>
                  <th className="px-3 py-2.5 text-right font-medium">Meses</th>
                  <th className="px-3 py-2.5 text-right font-medium">Deprec. {ejercicio}</th>
                  <th className="px-3 py-2.5 text-right font-medium">Saldo x deducir</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {data.activos.map((a) => (
                  <tr key={a.id} className="border-t border-cos-line">
                    <td className="px-4 py-3">
                      <p className="font-medium text-cos-ink">{a.descripcion}</p>
                      <p className="text-[11px] text-cos-ink-faint">
                        {TIPO_LABEL[a.tipo] ?? a.tipo} · alta {formatDate(a.fechaAdquisicion)}
                        {a.esAutomovil && " · automóvil"}
                        {a.depreciacion.topeAplicado && <span className="text-cos-amber-ink"> · tope Art. 36-II</span>}
                        {a.fechaBaja && <span className="text-cos-red-ink"> · baja {formatDate(a.fechaBaja)}</span>}
                        {a.autoCreado && (
                          <span className="text-cos-amber-ink"> · auto — revisa tipo/tasa{a.tipo === "transporte" ? "/tope auto-vs-carga" : ""}</span>
                        )}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      <Money value={a.moi} />
                      {a.depreciacion.topeAplicado && (
                        <p className="text-[11px] text-cos-amber-ink">deduc. {formatCurrency(a.depreciacion.moiDeducible)}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      {(a.depreciacion.tasaAnual * 100).toFixed(0)}%
                      {a.depreciacion.tasaAproximada && <span title="Tasa aproximada — confirma contra Art. 34/35"> *</span>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono">{a.depreciacion.mesesUsoEjercicio}</td>
                    <td className="px-3 py-3 text-right font-mono font-semibold">
                      <Money value={a.depreciacion.depreciacionEjercicio} />
                      {!a.depreciacion.sinActualizar && (
                        <p className="text-[11px] font-normal text-cos-ink-faint">
                          INPC ×{a.depreciacion.factorActualizacion.toFixed(4)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-cos-ink-soft"><Money value={a.depreciacion.saldoPendiente} /></td>
                    <td className="px-3 py-3 text-right">
                      <button onClick={() => eliminar(a.id)} className="text-cos-ink-faint hover:text-cos-red-ink" title="Eliminar">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-card border border-cos-line bg-white px-4 py-3 text-[12.5px] text-cos-ink-soft">
            <Info className="mt-0.5 h-4 w-4 flex-none text-cos-ink-faint" />
            <span>
              Actualización por <b>INPC</b> (Art. 31) aplicada cuando el índice del periodo está cargado
              (ene–ago 2016–2026; incluye junio, el numerador anual) — <b>INPC aún sin cotejar</b> contra la
              fuente oficial. Donde falta el índice, la cifra queda nominal. La depreciación <b>aún no se resta
              del ISR</b>: este registro prepara el dato para conectarlo a la declaración (excluyendo la inversión
              de las deducciones inmediatas en el mismo cambio). <code>*</code> = tasa aproximada.
            </span>
          </div>
        </>
      )}

      {showNew && (
        <NuevoActivoModal
          companyId={activeCompany.id}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); load(); }}
        />
      )}
    </div>
  );
}

function NuevoActivoModal({ companyId, onClose, onCreated }: { companyId: string; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    descripcion: "", tipo: "computo", moi: "", fechaAdquisicion: new Date().toISOString().slice(0, 10),
    esAutomovil: false, esElectricoHibrido: false,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/activos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          descripcion: form.descripcion,
          tipo: form.tipo,
          moi: parseFloat(form.moi),
          fechaAdquisicion: form.fechaAdquisicion,
          esAutomovil: form.esAutomovil,
          esElectricoHibrido: form.esElectricoHibrido,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md rounded-card bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold text-cos-ink">Alta de activo fijo</h2>
          <button type="button" onClick={onClose}><X className="h-5 w-5 text-cos-ink-soft" /></button>
        </div>
        <div className="space-y-3 text-[14px]">
          <label className="block">
            <span className="text-[12.5px] text-cos-ink-soft">Descripción</span>
            <input required value={form.descripcion} onChange={(e) => setForm((p) => ({ ...p, descripcion: e.target.value }))}
              className="mt-1 w-full rounded-control border border-cos-line px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-[12.5px] text-cos-ink-soft">Tipo de activo (tasa Art. 34)</span>
            <select value={form.tipo} onChange={(e) => setForm((p) => ({ ...p, tipo: e.target.value }))}
              className="mt-1 w-full rounded-control border border-cos-line px-3 py-2">
              {Object.entries(TIPO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[12.5px] text-cos-ink-soft">MOI (sin IVA)</span>
              <input required type="number" step="0.01" min="0" value={form.moi} onChange={(e) => setForm((p) => ({ ...p, moi: e.target.value }))}
                className="mt-1 w-full rounded-control border border-cos-line px-3 py-2" />
            </label>
            <label className="block">
              <span className="text-[12.5px] text-cos-ink-soft">Fecha de adquisición</span>
              <input required type="date" value={form.fechaAdquisicion} onChange={(e) => setForm((p) => ({ ...p, fechaAdquisicion: e.target.value }))}
                className="mt-1 w-full rounded-control border border-cos-line px-3 py-2" />
            </label>
          </div>
          {form.tipo === "transporte" && (
            <div className="rounded-control bg-cos-paper px-3 py-2.5 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.esAutomovil} onChange={(e) => setForm((p) => ({ ...p, esAutomovil: e.target.checked }))} />
                Es automóvil de pasajeros (tope MOI Art. 36-II; las camionetas de carga NO)
              </label>
              {form.esAutomovil && (
                <label className="mt-1.5 flex items-center gap-2">
                  <input type="checkbox" checked={form.esElectricoHibrido} onChange={(e) => setForm((p) => ({ ...p, esElectricoHibrido: e.target.checked }))} />
                  Eléctrico / híbrido (tope $250k en vez de $175k)
                </label>
              )}
            </div>
          )}
          {err && <p className="text-[13px] text-cos-red-ink">{err}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-control px-4 py-2 text-[14px] text-cos-ink-soft hover:bg-cos-paper">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-control bg-cos-brand px-4 py-2 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </div>
  );
}
