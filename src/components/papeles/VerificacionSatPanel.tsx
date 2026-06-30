"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Panel "Verificación contra SAT" — el fire test en una pantalla. Para el
// periodo seleccionado pone lado a lado lo que dice el app vs lo presentado al
// SAT y dictamina coincide / diverge / incompleto.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { Loader2, CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";

type LineaVerdict = "ok" | "diverge" | "sin_referencia";

interface VerificacionLinea {
  clave: string;
  titulo: string;
  appValor: number | null;
  satValor: number | null;
  diff: number | null;
  verdict: LineaVerdict;
  detalle: string;
}

interface ReadinessCheck {
  clave: string;
  estado: "ok" | "warn" | "error";
  titulo: string;
  detalle: string;
}

interface VerificacionData {
  companyId: string;
  periodo: string;
  veredicto: "coincide" | "diverge" | "incompleto";
  lineas: VerificacionLinea[];
  readiness: { status: "lista" | "con_huecos" | "incompleta"; resumen: string; checks: ReadinessCheck[] };
}

const CARD = "rounded-card border border-cos-line bg-cos-card shadow-card";

function VeredictoBadge({ v }: { v: VerificacionData["veredicto"] }) {
  const map = {
    coincide: { txt: "Coincide con el SAT", cls: "bg-cos-jade-tint text-cos-jade-ink", Icon: CheckCircle2 },
    diverge: { txt: "Diverge del SAT", cls: "bg-cos-red-tint text-cos-red-ink", Icon: AlertTriangle },
    incompleto: { txt: "Verificación incompleta", cls: "bg-cos-amber-tint text-cos-amber-ink", Icon: HelpCircle },
  } as const;
  const { txt, cls, Icon } = map[v];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${cls}`}>
      <Icon className="h-4 w-4" /> {txt}
    </span>
  );
}

function LineaIcon({ v }: { v: LineaVerdict }) {
  if (v === "ok") return <CheckCircle2 className="h-4 w-4 text-cos-jade-ink" />;
  if (v === "diverge") return <AlertTriangle className="h-4 w-4 text-cos-red-ink" />;
  return <HelpCircle className="h-4 w-4 text-cos-ink-faint" />;
}

export function VerificacionSatPanel({
  companyId,
  year,
  month,
}: {
  companyId: string;
  year: number;
  month: number;
}) {
  const [data, setData] = useState<VerificacionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/papeles/verificacion?companyId=${companyId}&year=${year}&month=${month}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "No se pudo correr la verificación.");
        setData(null);
      } else {
        setData(json as VerificacionData);
      }
    } catch {
      setError("Error de red. Inténtalo de nuevo.");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-cos-ink-soft p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Verificando contra el SAT…
      </div>
    );
  }
  if (error) {
    return <div className={`${CARD} p-6 text-sm text-cos-red-ink`}>{error}</div>;
  }
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className={`${CARD} p-5`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold text-cos-ink">Verificación contra el SAT</h2>
            <p className="text-sm text-cos-ink-soft mt-0.5">
              Compara el libro vivo y el cálculo del app contra lo presentado al SAT en {data.periodo}.
            </p>
          </div>
          <VeredictoBadge v={data.veredicto} />
        </div>
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <table className="w-full text-sm">
          <thead className="bg-cos-paper text-[11px] uppercase tracking-[0.02em] text-cos-ink-faint">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Concepto</th>
              <th className="text-right font-medium px-4 py-2.5">App</th>
              <th className="text-right font-medium px-4 py-2.5">SAT (presentado)</th>
              <th className="text-right font-medium px-4 py-2.5">Diferencia</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {data.lineas.map((l) => (
              <tr key={l.clave} className="border-t border-cos-line align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-cos-ink">{l.titulo}</div>
                  <div className="text-xs text-cos-ink-soft mt-0.5">{l.detalle}</div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {l.appValor == null ? "—" : <Money value={l.appValor} />}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {l.satValor == null ? "—" : <Money value={l.satValor} />}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {l.diff == null ? "—" : <Money value={l.diff} />}
                </td>
                <td className="px-4 py-3 text-center">
                  <LineaIcon v={l.verdict} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cobertura (readiness) como contexto */}
      <div className={`${CARD} p-5`}>
        <h3 className="font-semibold text-cos-ink text-sm">Cobertura de datos del periodo</h3>
        <p className="text-xs text-cos-ink-soft mt-0.5 mb-3">{data.readiness.resumen}</p>
        <ul className="space-y-2">
          {data.readiness.checks.map((c) => (
            <li key={c.clave} className="flex items-start gap-2 text-sm">
              {c.estado === "ok" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-cos-jade-ink" />
              ) : c.estado === "warn" ? (
                <HelpCircle className="h-4 w-4 shrink-0 mt-0.5 text-cos-amber-ink" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-cos-red-ink" />
              )}
              <span>
                <span className="font-medium text-cos-ink">{c.titulo}.</span>{" "}
                <span className="text-cos-ink-soft">{c.detalle}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-cos-ink-faint">
        La balanza vs SAT usa la Contabilidad Electrónica de Syntage. El IVA e ISR se comparan
        contra la declaración presentada capturada del mes; si falta, sube el acuse para verificar.
      </p>
    </div>
  );
}
