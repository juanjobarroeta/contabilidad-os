"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Paso de revisión e importación del roster reconstruido desde los CFDIs de
// nómina propios de la empresa. Tres buckets (activos / probables bajas / bajas),
// el usuario edita salario y confirma la inclusión. Nada se crea sin confirmar.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Loader2, AlertCircle, CheckCircle2, UserCheck, UserMinus, UserX,
  RefreshCw, Info,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";

type Estado = "ACTIVO" | "PROBABLE_BAJA" | "BAJA";

interface RosterSugerido {
  rfc: string;
  nombre: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  nombrePila: string;
  curp: string | null;
  nss: string | null;
  fechaIngreso: string | null;
  tipoContrato: string | null;
  tipoRegimen: string | null;
  puesto: string | null;
  departamento: string | null;
  riesgoPuesto: string | null;
  periodicidadPago: string | null;
  salarioDiario: number | null;
  salarioDiarioIntegrado: number | null;
  ultimoRecibo: string | null;
  estado: Estado;
  numRecibos: number;
  yaExiste: boolean;
}

interface Counts {
  totalRecibos: number;
  sinRawXml: number;
  noParseables: number;
  empleados: number;
  activos: number;
  probablesBajas: number;
  bajas: number;
  yaExisten: number;
}

interface Row extends RosterSugerido {
  incluir: boolean;
  salarioEditable: number;
}

const ESTADO_META: Record<Estado, { label: string; Icon: typeof UserCheck; cls: string }> = {
  ACTIVO: { label: "Activo", Icon: UserCheck, cls: "text-cos-jade-ink bg-cos-jade-tint" },
  PROBABLE_BAJA: { label: "Probable baja", Icon: UserMinus, cls: "text-cos-amber-ink bg-cos-amber-tint" },
  BAJA: { label: "Baja", Icon: UserX, cls: "text-cos-ink-soft bg-cos-slate-tint" },
};

export function RosterImport({
  companyId,
  onClose,
  onImported,
}: {
  companyId: string;
  onClose: () => void;
  onImported: (creados: number) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/nomina/roster-import?companyId=${companyId}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo detectar el roster");
        return;
      }
      setCounts(data.counts);
      const roster: RosterSugerido[] = data.roster ?? [];
      setRows(
        roster.map((r) => ({
          ...r,
          // Pre-seleccionamos los ACTIVOS no existentes; probables/bajas en blanco.
          incluir: r.estado === "ACTIVO" && !r.yaExiste,
          salarioEditable: r.salarioDiario ?? 0,
        }))
      );
    } catch {
      setError("Error de red al detectar el roster");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const buckets = useMemo(() => {
    return {
      ACTIVO: rows.filter((r) => r.estado === "ACTIVO"),
      PROBABLE_BAJA: rows.filter((r) => r.estado === "PROBABLE_BAJA"),
      BAJA: rows.filter((r) => r.estado === "BAJA"),
    };
  }, [rows]);

  const seleccionados = rows.filter((r) => r.incluir && !r.yaExiste);

  function setRow(rfc: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.rfc === rfc ? { ...r, ...patch } : r)));
  }

  async function importar() {
    if (seleccionados.length === 0) return;
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/nomina/roster-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          empleados: seleccionados.map((r) => ({
            rfc: r.rfc,
            nombre: r.nombrePila || r.nombre || r.rfc,
            apellidoPaterno: r.apellidoPaterno || "—",
            apellidoMaterno: r.apellidoMaterno,
            curp: r.curp,
            nss: r.nss,
            fechaIngreso: r.fechaIngreso,
            tipoContrato: r.tipoContrato,
            tipoRegimen: r.tipoRegimen,
            puesto: r.puesto,
            departamento: r.departamento,
            riesgoPuesto: r.riesgoPuesto,
            periodicidadPago: r.periodicidadPago,
            salarioDiario: r.salarioEditable,
            salarioDiarioIntegrado: r.salarioDiarioIntegrado,
            estado: r.estado,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo importar el roster");
        return;
      }
      onImported(data.creados ?? 0);
    } catch {
      setError("Error de red al importar");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="w-full max-w-[920px] rounded-xl bg-cos-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-cos-line px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-cos-ink">Importar equipo desde recibos de nómina</h2>
            <p className="mt-0.5 text-[13px] text-cos-ink-soft">
              Reconstruimos a tu equipo a partir de los CFDIs de nómina que ya timbraste. Revisa, ajusta el salario y confirma — nada se da de alta sin tu confirmación.
            </p>
          </div>
          <button onClick={onClose} className="ml-4 text-cos-ink-soft hover:text-cos-ink">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-soft">
              <Loader2 className="h-5 w-5 animate-spin" /> Analizando tus recibos de nómina...
            </div>
          ) : error && rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertCircle className="h-8 w-8 text-cos-red-ink" />
              <p className="text-sm text-cos-ink">{error}</p>
              <button onClick={load} className="inline-flex items-center gap-1.5 rounded-md border border-cos-line px-3 py-1.5 text-sm hover:bg-cos-paper">
                <RefreshCw className="h-3.5 w-3.5" /> Reintentar
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Info className="h-8 w-8 text-cos-ink-soft opacity-50" />
              <p className="text-sm font-medium text-cos-ink">No encontramos recibos de nómina con datos legibles</p>
              {counts && counts.sinRawXml > 0 ? (
                <p className="max-w-md text-[13px] text-cos-ink-soft">
                  Hay {counts.sinRawXml} recibo{counts.sinRawXml === 1 ? "" : "s"} sin el XML original guardado. Sincroniza tus CFDIs del SAT para recuperarlos y vuelve a intentarlo.
                </p>
              ) : (
                <p className="max-w-md text-[13px] text-cos-ink-soft">
                  Aún no hay CFDIs de nómina timbrados por esta empresa. Da de alta a tu equipo manualmente.
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Resumen de cobertura */}
              {counts && (
                <div className="mb-4 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
                  <Stat label="Empleados detectados" value={counts.empleados} />
                  <Stat label="Activos" value={counts.activos} tone="jade" />
                  <Stat label="Probables bajas" value={counts.probablesBajas} tone="amber" />
                  <Stat label="Bajas" value={counts.bajas} />
                </div>
              )}

              {counts && (counts.sinRawXml > 0 || counts.noParseables > 0) && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-cos-amber/40 bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink">
                  <Info className="mt-0.5 h-4 w-4 flex-none" />
                  <span>
                    {counts.sinRawXml > 0 && (
                      <>Se omitieron {counts.sinRawXml} recibo{counts.sinRawXml === 1 ? "" : "s"} sin XML original guardado (sincroniza tus CFDIs del SAT para recuperarlos). </>
                    )}
                    {counts.noParseables > 0 && (
                      <>{counts.noParseables} recibo{counts.noParseables === 1 ? "" : "s"} con XML ilegible o sin complemento de nómina.</>
                    )}
                  </span>
                </div>
              )}

              <div className="space-y-5">
                {(["ACTIVO", "PROBABLE_BAJA", "BAJA"] as const).map((estado) => {
                  const grupo = buckets[estado];
                  if (grupo.length === 0) return null;
                  const meta = ESTADO_META[estado];
                  return (
                    <Bucket
                      key={estado}
                      estado={estado}
                      rows={grupo}
                      meta={meta}
                      onChange={setRow}
                    />
                  );
                })}
              </div>

              <p className="mt-4 flex items-start gap-2 text-[12.5px] text-cos-ink-soft">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
                La CLABE y el banco para la dispersión SPEI se agregan después, al editar cada empleado en el roster.
              </p>

              {error && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-4 py-2.5 text-sm text-cos-red-ink">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && rows.length > 0 && (
          <div className="flex items-center justify-between border-t border-cos-line px-6 py-4">
            <span className="text-[13px] text-cos-ink-soft">
              {seleccionados.length} empleado{seleccionados.length === 1 ? "" : "s"} seleccionado{seleccionados.length === 1 ? "" : "s"} para importar
            </span>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="rounded-md border border-cos-line px-4 py-2 text-sm hover:bg-cos-paper">
                Cancelar
              </button>
              <button
                onClick={importar}
                disabled={seleccionados.length === 0 || importing}
                className="inline-flex items-center gap-2 rounded-md bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Importar {seleccionados.length > 0 ? seleccionados.length : ""}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "jade" | "amber" }) {
  const cls =
    tone === "jade" ? "text-cos-jade-ink" : tone === "amber" ? "text-cos-amber-ink" : "text-cos-ink";
  return (
    <div className="rounded-lg border border-cos-line bg-cos-paper px-3 py-2">
      <p className={`font-mono text-lg font-bold ${cls}`}>{value}</p>
      <p className="text-[11.5px] text-cos-ink-soft">{label}</p>
    </div>
  );
}

function Bucket({
  estado,
  rows,
  meta,
  onChange,
}: {
  estado: Estado;
  rows: Row[];
  meta: { label: string; Icon: typeof UserCheck; cls: string };
  onChange: (rfc: string, patch: Partial<Row>) => void;
}) {
  const { Icon } = meta;
  return (
    <div className="overflow-hidden rounded-xl border border-cos-line">
      <div className={`flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold ${meta.cls}`}>
        <Icon className="h-4 w-4" />
        {meta.label} ({rows.length})
        {estado === "PROBABLE_BAJA" && (
          <span className="ml-1 font-normal opacity-80">— sin recibo reciente; revisa antes de incluir</span>
        )}
        {estado === "BAJA" && (
          <span className="ml-1 font-normal opacity-80">— último recibo fue finiquito/separación</span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-cos-line bg-cos-slate-tint/50">
            <th className="w-10 px-3 py-2"></th>
            <th className="px-3 py-2 text-left text-xs font-medium text-cos-ink-soft">Empleado</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-cos-ink-soft">Puesto</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-cos-ink-soft">Salario diario</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-cos-ink-soft">Último recibo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rfc} className="border-b border-cos-line last:border-0">
              <td className="px-3 py-2.5 text-center">
                {r.yaExiste ? (
                  <span title="Ya existe — se omite" className="text-[11px] text-cos-ink-faint">Ya existe</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={r.incluir}
                    onChange={(e) => onChange(r.rfc, { incluir: e.target.checked })}
                    className="h-4 w-4 accent-cos-brand"
                  />
                )}
              </td>
              <td className="px-3 py-2.5">
                <p className={`font-medium ${r.yaExiste ? "text-cos-ink-faint" : "text-cos-ink"}`}>
                  {r.nombre ?? r.rfc}
                </p>
                <p className="font-mono text-[11px] text-cos-ink-soft">{r.rfc}</p>
              </td>
              <td className="px-3 py-2.5 text-xs text-cos-ink-soft">
                {r.puesto ?? "—"}
                {r.departamento && <p>{r.departamento}</p>}
              </td>
              <td className="px-3 py-2.5 text-right">
                {r.yaExiste ? (
                  <span className="font-mono text-xs text-cos-ink-faint">{formatCurrency(r.salarioDiario ?? 0)}</span>
                ) : (
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={r.salarioEditable || ""}
                    onChange={(e) => onChange(r.rfc, { salarioEditable: Number(e.target.value) })}
                    className="w-28 rounded-md border border-cos-line px-2 py-1 text-right font-mono text-xs focus:border-cos-brand focus:outline-none"
                  />
                )}
              </td>
              <td className="px-3 py-2.5 text-xs text-cos-ink-soft">
                {r.ultimoRecibo ? (
                  <>
                    {formatDate(r.ultimoRecibo)}
                    {estado === "PROBABLE_BAJA" && (
                      <p className="text-cos-amber-ink">sin recibo desde {formatDate(r.ultimoRecibo)}</p>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
