"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Panel de operador: cómo se porta la DESCARGA DE CE DEL SAT (worker Playwright,
// servicio `ce-worker` en Railway, cron mensual). Los logs del worker son
// efímeros; este panel lee lo que dejó REGISTRADO por empresa
// (/api/operador/ce-sat-estado) + la cobertura en CeBalanzaMes. Sólo operador.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { Loader2, DatabaseZap, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

interface Fila {
  rfc: string;
  razonSocial: string | null;
  tier: string;
  syncEn: string | null;
  syncOk: boolean | null;
  syncNuevos: number | null;
  syncInfo: string | null;
  periodos: number;
  ultimoPeriodo: string | null;
}
interface Resumen { total: number; ok: number; sinBuzon: number; error: number; nuncaCorrio: number; conDatos: number }
interface Data { resumen: Resumen; empresas: Fila[] }

function estado(f: Fila): { label: string; cls: string } {
  if (f.syncEn == null) return { label: "sin correr", cls: "bg-cos-slate-tint text-cos-ink-soft" };
  if (f.syncOk) return { label: "ok", cls: "bg-cos-jade-tint text-cos-jade-ink" };
  if (/sinBuzón/i.test(f.syncInfo ?? "")) return { label: "sin buzón", cls: "bg-cos-amber-tint text-cos-amber-ink" };
  return { label: "error", cls: "bg-cos-red-tint text-cos-red-ink" };
}

const fechaCorta = (s: string | null) =>
  s == null ? "—" : new Date(s).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function CeSatPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function cargar() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/operador/ce-sat-estado");
      if (res.status === 403) { setDenied(true); return; }
      const j = (await res.json().catch(() => null)) as Data | null;
      if (!j) throw new Error("respuesta vacía");
      setData(j);
    } catch (e) {
      setError(String(e).slice(0, 120));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void cargar(); }, []);

  if (denied) return null; // el gate de la página ya muestra el candado

  const r = data?.resumen;
  return (
    <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
            <DatabaseZap className="h-4 w-4 text-cos-brand" /> Descarga de CE del SAT (worker)
          </h2>
          <p className="mt-1 text-[12.5px] text-cos-ink-soft">
            Cómo se porta el worker mensual (Railway): última corrida, resultado y cobertura por empresa.
          </p>
        </div>
        <button
          onClick={() => void cargar()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-control border border-cos-line px-3 py-1.5 text-[13px] font-medium text-cos-ink-soft hover:bg-cos-slate-tint disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Actualizar
        </button>
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-cos-red-ink">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      )}

      {r && (
        <div className="mt-3 flex flex-wrap gap-2 text-[12.5px]">
          <span className="rounded-control bg-cos-slate-tint px-2.5 py-1 text-cos-ink-soft">{r.total} elegibles</span>
          <span className="rounded-control bg-cos-jade-tint px-2.5 py-1 text-cos-jade-ink">{r.ok} ok</span>
          <span className="rounded-control bg-cos-amber-tint px-2.5 py-1 text-cos-amber-ink">{r.sinBuzon} sin buzón</span>
          <span className="rounded-control bg-cos-red-tint px-2.5 py-1 text-cos-red-ink">{r.error} error</span>
          <span className="rounded-control bg-cos-slate-tint px-2.5 py-1 text-cos-ink-soft">{r.nuncaCorrio} sin correr</span>
          <span className="rounded-control bg-cos-brand-tint px-2.5 py-1 text-cos-brand-ink">{r.conDatos} con datos</span>
        </div>
      )}

      {data && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-cos-ink-soft">
                <th className="py-1.5 pr-3 font-medium">RFC</th>
                <th className="py-1.5 pr-3 font-medium">Empresa</th>
                <th className="py-1.5 pr-3 font-medium">Estado</th>
                <th className="py-1.5 pr-3 font-medium">Última corrida</th>
                <th className="py-1.5 pr-3 text-right font-medium">Nuevos</th>
                <th className="py-1.5 pr-3 text-right font-medium">Períodos</th>
                <th className="py-1.5 pr-3 font-medium">Último</th>
                <th className="py-1.5 font-medium">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {data.empresas.map((f) => {
                const e = estado(f);
                return (
                  <tr key={f.rfc} className="border-t border-cos-line">
                    <td className="py-1.5 pr-3 font-mono text-cos-ink">{f.rfc}</td>
                    <td className="py-1.5 pr-3 text-cos-ink-soft">{(f.razonSocial ?? "").slice(0, 26)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", e.cls)}>{e.label}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-cos-ink-soft">{fechaCorta(f.syncEn)}</td>
                    <td className="py-1.5 pr-3 text-right text-cos-ink">{f.syncNuevos ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right text-cos-ink">{f.periodos}</td>
                    <td className="py-1.5 pr-3 text-cos-ink-soft">{f.ultimoPeriodo ?? "—"}</td>
                    <td className="py-1.5 text-cos-ink-faint">{(f.syncInfo ?? "").slice(0, 60)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
