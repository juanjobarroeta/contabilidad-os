"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Portal de crédito del OPERADOR — portafolio de clientes evaluables + ficha
// de crédito por empresa. No es parte de la operación contable de la empresa:
// es el negocio de crédito del operador, montado sobre los datos fiscales que
// el sistema ya tiene (declaraciones, cumplimiento, EFOS, CFDIs).
//
// Cada evaluación es un snapshot inmutable con su desglose y sus insumos;
// aquí sólo se captura la resolución humana (decisión + notas).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Banknote, ChevronLeft, Loader2, RefreshCw, ShieldAlert,
} from "lucide-react";
import { Card } from "@/components/ui";
import { montoPorPago, tablaAmortizacion } from "@/lib/credito/amortizacion";

interface UltimaEval {
  score: number;
  banda: string;
  limiteSugerido: number;
  provisional: boolean;
  decision: string | null;
  createdAt: string;
}
interface EmpresaPortafolio {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string | null;
  tier: string | null;
  ultimaEvaluacion: UltimaEval | null;
}
interface Dimension {
  clave: string;
  etiqueta: string;
  peso: number;
  puntos: number;
  razones: string[];
}
interface Evaluacion {
  id: string;
  createdAt: string;
  score: number;
  banda: string;
  limiteSugerido: number;
  provisional: boolean;
  detalle: {
    dimensiones: Dimension[];
    flujoLibreMensual?: number | null;
    pagoMensualMax?: number | null;
    capacidadDesglose?: {
      ingresosProm: number;
      gastosProm: number;
      nominaProm: number;
      impuestosProm: number;
      flujoLibre: number;
      theta: number;
    } | null;
    insumos?: {
      declaraciones?: Array<{ periodo: string; ingresos: number | null; impuestosPagados: number }>;
      gastosPorMes?: Array<{ periodo: string; total: number }>;
      cfdis?: { facturadoPorMes?: Array<{ periodo: string; total: number }> } | null;
    };
  };
  cobertura: string[];
  decision: string | null;
  notas: string | null;
  analisis: string | null;
}

/** Serie mensual: ingresos declarados vs gastos facturados (barras) con lo
 *  facturado en CFDIs encima (puntos). Todo del snapshot — SVG puro, sin
 *  librerías. La tabla colapsable da los números exactos. */
function SerieMensual({ detalle }: { detalle: Evaluacion["detalle"] }) {
  const [verTabla, setVerTabla] = useState(false);

  const decls = detalle.insumos?.declaraciones ?? [];
  const gastosMap = new Map((detalle.insumos?.gastosPorMes ?? []).map((g) => [g.periodo, g.total]));
  const factMap = new Map((detalle.insumos?.cfdis?.facturadoPorMes ?? []).map((f) => [f.periodo, f.total]));

  // Últimos 15 meses con ingreso declarado, en orden cronológico.
  const meses = decls
    .filter((d) => d.ingresos != null)
    .sort((a, b) => a.periodo.localeCompare(b.periodo))
    .slice(-15)
    .map((d) => ({
      periodo: d.periodo,
      ingresos: d.ingresos ?? 0,
      gastos: gastosMap.get(d.periodo) ?? 0,
      facturado: factMap.get(d.periodo) ?? null,
      impuestos: d.impuestosPagados,
    }));
  if (meses.length < 3) return null;

  const W = 940, H = 210, PAD = 8, baseY = H - 26;
  const max = Math.max(...meses.map((m) => Math.max(m.ingresos, m.gastos, m.facturado ?? 0)), 1);
  const slot = (W - PAD * 2) / meses.length;
  const barW = Math.min(26, slot * 0.32);
  const y = (v: number) => baseY - (v / max) * (baseY - 18);
  const etiqueta = (p: string) => {
    const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    const [yy, mm] = p.split("-");
    return `${MES[Number(mm) - 1]} ${yy.slice(2)}`;
  };

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-cos-ink">Ingresos y gastos por mes</p>
        <div className="flex items-center gap-3 text-[11.5px] text-cos-ink-soft">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-cos-brand" /> Ingresos declarados</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-cos-red-ink/70" /> Gastos facturados</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-cos-jade-ink" /> Facturado (CFDI)</span>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[640px] w-full">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity="0.08" />
          ))}
          {meses.map((m, i) => {
            const cx = PAD + slot * i + slot / 2;
            return (
              <g key={m.periodo}>
                <title>{`${etiqueta(m.periodo)} · ingresos ${fmtMoney(m.ingresos)} · gastos ${fmtMoney(m.gastos)}${m.facturado != null ? ` · facturado ${fmtMoney(m.facturado)}` : ""} · impuestos ${fmtMoney(m.impuestos)}`}</title>
                <rect x={cx - barW - 1} y={y(m.ingresos)} width={barW} height={baseY - y(m.ingresos)} rx="2" className="fill-cos-brand" />
                <rect x={cx + 1} y={y(m.gastos)} width={barW} height={Math.max(1, baseY - y(m.gastos))} rx="2" className="fill-cos-red-ink" opacity="0.7" />
                {m.facturado != null && <circle cx={cx} cy={y(m.facturado)} r="3.5" className="fill-cos-jade-ink" />}
                <text x={cx} y={H - 8} textAnchor="middle" className="fill-cos-ink-faint" fontSize="10">{etiqueta(m.periodo)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <button onClick={() => setVerTabla(!verTabla)} className="mt-2 text-[13px] font-medium text-cos-brand-ink hover:underline">
        {verTabla ? "Ocultar tabla mensual" : "Ver tabla mensual"}
      </button>
      {verTabla && (
        <div className="mt-2 max-h-[300px] overflow-y-auto rounded-control border border-cos-line">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-cos-paper text-[11px] uppercase tracking-[0.02em] text-cos-ink-faint">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Mes</th>
                <th className="px-3 py-2 text-right font-medium">Ingresos declarados</th>
                <th className="px-3 py-2 text-right font-medium">Facturado (CFDI)</th>
                <th className="px-3 py-2 text-right font-medium">Gastos facturados</th>
                <th className="px-3 py-2 text-right font-medium">Impuestos pagados</th>
                <th className="px-3 py-2 text-right font-medium">Flujo estimado</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {[...meses].reverse().map((m) => (
                <tr key={m.periodo} className="border-t border-cos-line-soft">
                  <td className="px-3 py-1.5 text-cos-ink-soft">{etiqueta(m.periodo)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink">{fmtMoney(m.ingresos)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink-soft">{m.facturado != null ? fmtMoney(m.facturado) : "—"}</td>
                  <td className="px-3 py-1.5 text-right text-cos-red-ink">{fmtMoney(m.gastos)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink-soft">{fmtMoney(m.impuestos)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-cos-ink">{fmtMoney(m.ingresos - m.gastos - m.impuestos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * Simulador de préstamo: parte de CUÁNTO PUEDE PAGAR el cliente al mes (del
 * snapshot: fracción del flujo libre según banda) y con tasa + plazo deriva
 * CUÁNTO PRESTARLE (valor presente de la anualidad) — con su tabla de
 * amortización. Todo en vivo, matemática pura del lado del cliente.
 */
function SimuladorPrestamo({
  pagoInicial,
  desglose,
  banda,
  limiteSugerido,
}: {
  pagoInicial: number | null;
  desglose: NonNullable<Evaluacion["detalle"]["capacidadDesglose"]> | null;
  banda: string;
  limiteSugerido: number;
}) {
  const [pago, setPago] = useState(pagoInicial != null ? String(Math.round(pagoInicial)) : "");
  const [tasa, setTasa] = useState("36");
  const [plazo, setPlazo] = useState("12");
  const [verTabla, setVerTabla] = useState(false);
  const [verComoSeCalcula, setVerComoSeCalcula] = useState(false);

  const pagoNum = Number(pago) || 0;
  const tasaNum = (Number(tasa) || 0) / 100;
  const plazoNum = Math.max(0, Math.round(Number(plazo) || 0));

  const monto = useMemo(() => montoPorPago(pagoNum, tasaNum, plazoNum), [pagoNum, tasaNum, plazoNum]);
  const tabla = useMemo(
    () => (verTabla && monto > 0 ? tablaAmortizacion(monto, tasaNum, plazoNum) : []),
    [verTabla, monto, tasaNum, plazoNum],
  );
  const interesTotal = useMemo(() => tabla.reduce((s, f) => s + f.interes, 0), [tabla]);

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-cos-ink">Simulador de préstamo</p>
        <p className="text-[12px] text-cos-ink-faint">
          del pago mensual que puede cubrir → cuánto prestarle (sistema francés)
        </p>
      </div>
      {pagoInicial == null && (
        <p className="mt-2 text-[12.5px] text-cos-amber-ink">
          Sin flujo libre estimado en la evaluación — captura el pago mensual a mano.
        </p>
      )}
      {desglose && (
        <>
          <button
            onClick={() => setVerComoSeCalcula(!verComoSeCalcula)}
            className="mt-2 text-[12.5px] font-medium text-cos-brand-ink hover:underline"
          >
            {verComoSeCalcula ? "Ocultar cálculo del pago" : "¿Cómo se calcula el pago que puede cubrir?"}
          </button>
          {verComoSeCalcula && (
            <div className="mt-2 rounded-control border border-cos-line bg-cos-paper p-3.5 text-[12.5px]">
              <div className="grid max-w-[420px] grid-cols-[1fr_auto] gap-y-1">
                <span className="text-cos-ink-soft">Ingresos declarados promedio / mes</span>
                <span className="text-right font-mono text-cos-ink">{fmtMoney(desglose.ingresosProm)}</span>
                <span className="text-cos-ink-soft">− Gastos facturados promedio / mes</span>
                <span className="text-right font-mono text-cos-red-ink">−{fmtMoney(desglose.gastosProm)}</span>
                <span className="text-cos-ink-soft">− Nómina timbrada promedio / mes</span>
                <span className="text-right font-mono text-cos-red-ink">−{fmtMoney(desglose.nominaProm)}</span>
                <span className="text-cos-ink-soft">− Impuestos pagados promedio / mes</span>
                <span className="text-right font-mono text-cos-red-ink">−{fmtMoney(desglose.impuestosProm)}</span>
                <span className="border-t border-cos-line pt-1 font-medium text-cos-ink">= Flujo libre estimado / mes</span>
                <span className="border-t border-cos-line pt-1 text-right font-mono font-medium text-cos-ink">{fmtMoney(desglose.flujoLibre)}</span>
                <span className="text-cos-ink-soft">× Razón de servicio de deuda (banda {banda})</span>
                <span className="text-right font-mono text-cos-ink">{Math.round(desglose.theta * 100)}%</span>
                <span className="pt-1 font-semibold text-cos-brand-ink">= Pago mensual que puede cubrir</span>
                <span className="pt-1 text-right font-mono font-semibold text-cos-brand-ink">
                  {fmtMoney(Math.round(desglose.flujoLibre * desglose.theta))}
                </span>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-cos-ink-faint">
                La razón de servicio de deuda limita cuánto del flujo libre se compromete al crédito según el
                riesgo: banda A 40%, B 30%, C 20%, D 0%. Los promedios salen de los CFDIs y declaraciones del
                snapshot; sin CFDIs de gasto el flujo puede estar sobreestimado (compras sin factura).
              </p>
            </div>
          )}
        </>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="block text-[12.5px] text-cos-ink-soft">
          Pago mensual que puede cubrir
          <input
            type="number" min="0" step="500" value={pago}
            onChange={(e) => setPago(e.target.value)}
            className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 font-mono text-[13.5px] text-cos-ink outline-none"
          />
        </label>
        <label className="block text-[12.5px] text-cos-ink-soft">
          Tasa anual (%)
          <input
            type="number" min="0" step="1" value={tasa}
            onChange={(e) => setTasa(e.target.value)}
            className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 font-mono text-[13.5px] text-cos-ink outline-none"
          />
        </label>
        <label className="block text-[12.5px] text-cos-ink-soft">
          Plazo (meses)
          <input
            type="number" min="1" step="1" value={plazo}
            onChange={(e) => setPlazo(e.target.value)}
            className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 font-mono text-[13.5px] text-cos-ink outline-none"
          />
        </label>
        <div className="rounded-control bg-cos-brand-tint px-3 py-2">
          <p className="text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-brand-ink">Monto prestable</p>
          <p className="font-mono text-[18px] font-semibold text-cos-brand-ink">{fmtMoney(monto)}</p>
        </div>
      </div>
      {monto > limiteSugerido && limiteSugerido > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Este monto supera el límite sugerido por el score ({fmtMoney(limiteSugerido)}): el pago sale del
          flujo, pero el límite acota la exposición total. Prestar por encima es decisión manual — déjala en
          las notas de la resolución.
        </p>
      )}
      {monto > 0 && (
        <button
          onClick={() => setVerTabla(!verTabla)}
          className="mt-3 text-[13px] font-medium text-cos-brand-ink hover:underline"
        >
          {verTabla ? "Ocultar tabla de amortización" : "Ver tabla de amortización"}
        </button>
      )}
      {verTabla && tabla.length > 0 && (
        <div className="mt-2 max-h-[320px] overflow-y-auto rounded-control border border-cos-line">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-cos-paper text-[11px] uppercase tracking-[0.02em] text-cos-ink-faint">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Mes</th>
                <th className="px-3 py-2 text-right font-medium">Pago</th>
                <th className="px-3 py-2 text-right font-medium">Interés</th>
                <th className="px-3 py-2 text-right font-medium">Capital</th>
                <th className="px-3 py-2 text-right font-medium">Saldo</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {tabla.map((f) => (
                <tr key={f.mes} className="border-t border-cos-line-soft">
                  <td className="px-3 py-1.5 text-cos-ink-soft">{f.mes}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink">{fmtMoney(f.pago)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink-soft">{fmtMoney(f.interes)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink-soft">{fmtMoney(f.capital)}</td>
                  <td className="px-3 py-1.5 text-right text-cos-ink-faint">{fmtMoney(f.saldo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-cos-line bg-cos-paper px-3 py-2 text-right text-[12px] text-cos-ink-soft">
            Interés total del crédito: <span className="font-mono font-medium text-cos-ink">{fmtMoney(interesTotal)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Markdown mínimo del memo: **negritas** y viñetas — sin librerías. */
function MemoIA({ texto }: { texto: string }) {
  return (
    <div className="space-y-1">
      {texto.split("\n").map((linea, i) => {
        const t = linea.trim();
        if (!t) return <div key={i} className="h-1.5" />;
        const negrita = /^\*\*(.+)\*\*$/.exec(t);
        if (negrita) {
          return <p key={i} className="pt-1 text-[13px] font-semibold text-cos-ink">{negrita[1]}</p>;
        }
        const vineta = /^[-•]\s+(.*)$/.exec(t);
        const cuerpo = (vineta ? vineta[1] : t).replace(/\*\*(.+?)\*\*/g, "$1");
        return (
          <p key={i} className="text-[13px] leading-relaxed text-cos-ink-soft">
            {vineta ? "· " : ""}{cuerpo}
          </p>
        );
      })}
    </div>
  );
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n);
const fmtFecha = (iso: string) => {
  const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MES[d.getMonth()]} ${d.getFullYear()}`;
};

const BANDA_STYLE: Record<string, string> = {
  A: "bg-cos-jade-tint text-cos-jade-ink",
  B: "bg-cos-brand-tint text-cos-brand-ink",
  C: "bg-cos-amber-tint text-cos-amber-ink",
  D: "bg-cos-red-tint text-cos-red-ink",
};

function BandaChip({ banda, score }: { banda: string; score: number }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold ${BANDA_STYLE[banda] ?? "bg-cos-slate-tint text-cos-ink-soft"}`}>
      {banda} · {score}
    </span>
  );
}

export default function CreditosPage() {
  const [portafolio, setPortafolio] = useState<EmpresaPortafolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<EmpresaPortafolio | null>(null);
  const [evaluaciones, setEvaluaciones] = useState<Evaluacion[]>([]);
  const [loadingFicha, setLoadingFicha] = useState(false);
  const [evaluando, setEvaluando] = useState(false);
  const [error, setError] = useState("");
  // Resolución de la evaluación más reciente.
  const [decision, setDecision] = useState("");
  const [notas, setNotas] = useState("");
  const [guardando, setGuardando] = useState(false);

  const cargarPortafolio = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/creditos");
      const data = await res.json();
      setPortafolio(Array.isArray(data?.portafolio) ? data.portafolio : []);
      if (!res.ok) setError(data?.error ?? "No se pudo cargar el portafolio");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargarPortafolio(); }, [cargarPortafolio]);

  const cargarFicha = useCallback(async (empresa: EmpresaPortafolio) => {
    setSel(empresa);
    setLoadingFicha(true);
    setError("");
    try {
      const res = await fetch(`/api/creditos?companyId=${empresa.id}`);
      const data = await res.json();
      const evals: Evaluacion[] = Array.isArray(data?.evaluaciones) ? data.evaluaciones : [];
      setEvaluaciones(evals);
      setDecision(evals[0]?.decision ?? "");
      setNotas(evals[0]?.notas ?? "");
    } finally {
      setLoadingFicha(false);
    }
  }, []);

  async function evaluar() {
    if (!sel || evaluando) return;
    setEvaluando(true);
    setError("");
    try {
      const res = await fetch("/api/creditos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: sel.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? "No se pudo evaluar"); return; }
      await cargarFicha(sel);
      cargarPortafolio();
    } finally {
      setEvaluando(false);
    }
  }

  async function guardarResolucion() {
    const actual = evaluaciones[0];
    if (!actual || guardando) return;
    setGuardando(true);
    try {
      const res = await fetch("/api/creditos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: actual.id, decision: decision || null, notas: notas || null }),
      });
      if (res.ok) {
        setEvaluaciones((prev) => prev.map((e, i) => (i === 0 ? { ...e, decision: decision || null, notas: notas || null } : e)));
        cargarPortafolio();
      }
    } finally {
      setGuardando(false);
    }
  }

  const actual = evaluaciones[0] ?? null;

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">
            <Banknote className="h-7 w-7 text-cos-brand-ink" /> Créditos
          </h1>
          <p className="mt-1.5 max-w-[64ch] text-[15px] text-cos-ink-soft">
            Score de crédito por cliente a partir de sus datos fiscales reales: declaraciones, cumplimiento,
            EFOS y CFDIs. Cada evaluación queda como snapshot inmutable.
          </p>
        </div>
        {sel && (
          <button
            onClick={() => { setSel(null); setEvaluaciones([]); }}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3.5 py-2 text-[13.5px] font-medium text-cos-ink hover:bg-cos-paper"
          >
            <ChevronLeft className="h-4 w-4" /> Portafolio
          </button>
        )}
      </div>

      {error && (
        <p className="mt-4 flex items-center gap-2 rounded-control bg-cos-red-tint px-4 py-2.5 text-[13.5px] text-cos-red-ink">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      )}

      {/* ── Portafolio ── */}
      {!sel && (
        loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-cos-ink-faint">
            <Loader2 className="h-5 w-5 animate-spin" /> Cargando portafolio…
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
                  <th className="hidden px-4 py-2.5 text-left font-medium md:table-cell">Plan</th>
                  <th className="px-4 py-2.5 text-left font-medium">Score</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Límite sugerido</th>
                  <th className="hidden px-4 py-2.5 text-left font-medium lg:table-cell">Decisión</th>
                  <th className="hidden px-4 py-2.5 text-left font-medium lg:table-cell">Última evaluación</th>
                </tr>
              </thead>
              <tbody>
                {portafolio.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => cargarFicha(c)}
                    className="cursor-pointer border-t border-cos-line transition-colors hover:bg-cos-paper/60"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-cos-ink">{c.razonSocial}</p>
                      <p className="font-mono text-[11.5px] text-cos-ink-faint">{c.rfc}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-[12.5px] text-cos-ink-soft md:table-cell">{c.tier ?? "—"}</td>
                    <td className="px-4 py-3">
                      {c.ultimaEvaluacion ? (
                        <span className="inline-flex items-center gap-1.5">
                          <BandaChip banda={c.ultimaEvaluacion.banda} score={c.ultimaEvaluacion.score} />
                          {c.ultimaEvaluacion.provisional && (
                            <span className="text-[11px] text-cos-amber-ink" title="Faltaron insumos — score parcial">prov.</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[12.5px] text-cos-ink-faint">Sin evaluar</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-[13px] text-cos-ink sm:table-cell">
                      {c.ultimaEvaluacion ? fmtMoney(c.ultimaEvaluacion.limiteSugerido) : "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-[12.5px] text-cos-ink-soft lg:table-cell">
                      {c.ultimaEvaluacion?.decision ?? "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-[12.5px] text-cos-ink-faint lg:table-cell">
                      {c.ultimaEvaluacion ? fmtFecha(c.ultimaEvaluacion.createdAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── Ficha de crédito ── */}
      {sel && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[18px] font-semibold text-cos-ink">{sel.razonSocial}</p>
              <p className="font-mono text-[12.5px] text-cos-ink-faint">{sel.rfc} · {sel.tier ?? "sin plan"}</p>
            </div>
            <button
              onClick={evaluar}
              disabled={evaluando}
              className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {evaluando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {evaluando ? "Evaluando…" : actual ? "Evaluar de nuevo" : "Evaluar ahora"}
            </button>
          </div>

          {loadingFicha ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[14px] text-cos-ink-faint">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando ficha…
            </div>
          ) : !actual ? (
            <Card className="rounded-card border-cos-line p-8 text-center shadow-card">
              <p className="text-[14px] font-medium text-cos-ink">Sin evaluaciones todavía</p>
              <p className="mt-1 text-[13px] text-cos-ink-soft">
                «Evaluar ahora» corre el score con los datos fiscales actuales y guarda el snapshot.
              </p>
            </Card>
          ) : (
            <>
              {/* Resumen de la evaluación vigente */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Card className="rounded-card border-cos-line p-5 shadow-card">
                  <span className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Score</span>
                  <div className="mt-1.5"><BandaChip banda={actual.banda} score={actual.score} /></div>
                  <p className="mt-1.5 text-[12px] text-cos-ink-faint">{fmtFecha(actual.createdAt)}{actual.provisional ? " · provisional" : ""}</p>
                </Card>
                <Card className="rounded-card border-cos-line p-5 shadow-card">
                  <span className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Límite sugerido</span>
                  <div className="mt-1.5 text-[24px] font-semibold tracking-[-0.02em] text-cos-ink">{fmtMoney(actual.limiteSugerido)}</div>
                  <p className="mt-1 text-[12px] text-cos-ink-faint">múltiplo del ingreso mensual según banda</p>
                </Card>
                <Card className="rounded-card border-cos-line p-5 shadow-card">
                  <span className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Cobertura de datos</span>
                  {actual.cobertura.length === 0 ? (
                    <p className="mt-1.5 text-[13.5px] font-medium text-cos-jade-ink">Completa</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {actual.cobertura.map((c, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[12px] text-cos-amber-ink">
                          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" /> {c}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              {/* Serie mensual: ingresos vs gastos con facturado encima */}
              <SerieMensual detalle={actual.detalle} />

              {/* Simulador: pago que puede cubrir → monto prestable + tabla */}
              <SimuladorPrestamo
                pagoInicial={actual.detalle.pagoMensualMax ?? null}
                desglose={actual.detalle.capacidadDesglose ?? null}
                banda={actual.banda}
                limiteSugerido={actual.limiteSugerido}
              />

              {/* Memo de análisis (IA) — parte del snapshot */}
              {actual.analisis && (
                <Card className="rounded-card border-cos-line p-5 shadow-card">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-cos-ink">Análisis del expediente</span>
                    <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 text-[11px] font-medium text-cos-brand-ink">
                      generado por IA · {fmtFecha(actual.createdAt)}
                    </span>
                  </div>
                  <MemoIA texto={actual.analisis} />
                </Card>
              )}

              {/* Desglose por dimensión */}
              <Card className="overflow-hidden rounded-card border-cos-line shadow-card">
                <div className="border-b border-cos-line px-[18px] py-3">
                  <span className="text-[13px] font-semibold text-cos-ink">Desglose del score</span>
                </div>
                {actual.detalle.dimensiones.map((d) => (
                  <div key={d.clave} className="border-b border-cos-line px-[18px] py-3 last:border-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13.5px] font-medium text-cos-ink">
                        {d.etiqueta} <span className="text-[11.5px] text-cos-ink-faint">peso {d.peso}%</span>
                      </p>
                      <span className="font-mono text-[13.5px] font-semibold text-cos-ink">{d.puntos}/100</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cos-paper">
                      <div className="h-full rounded-full bg-cos-brand" style={{ width: `${d.puntos}%` }} />
                    </div>
                    <ul className="mt-2 space-y-0.5">
                      {d.razones.map((r, i) => (
                        <li key={i} className="text-[12.5px] text-cos-ink-soft">· {r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </Card>

              {/* Resolución humana */}
              <Card className="rounded-card border-cos-line p-5 shadow-card">
                <p className="text-[13px] font-semibold text-cos-ink">Resolución</p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr_auto]">
                  <select
                    value={decision}
                    onChange={(e) => setDecision(e.target.value)}
                    className="rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none"
                  >
                    <option value="">Sin decidir</option>
                    <option value="APROBADO">Aprobado</option>
                    <option value="RECHAZADO">Rechazado</option>
                    <option value="PENDIENTE">Pendiente de datos</option>
                  </select>
                  <input
                    value={notas}
                    onChange={(e) => setNotas(e.target.value)}
                    placeholder="Notas (condiciones, garantías, contexto…)"
                    className="rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none"
                  />
                  <button
                    onClick={guardarResolucion}
                    disabled={guardando}
                    className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                  >
                    {guardando ? "Guardando…" : "Guardar"}
                  </button>
                </div>
              </Card>

              {/* Historial */}
              {evaluaciones.length > 1 && (
                <Card className="overflow-hidden rounded-card border-cos-line shadow-card">
                  <div className="border-b border-cos-line px-[18px] py-3">
                    <span className="text-[13px] font-semibold text-cos-ink">Historial de evaluaciones</span>
                  </div>
                  {evaluaciones.slice(1).map((e) => (
                    <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-[18px] py-2.5 last:border-0">
                      <span className="text-[12.5px] text-cos-ink-faint">{fmtFecha(e.createdAt)}</span>
                      <BandaChip banda={e.banda} score={e.score} />
                      <span className="font-mono text-[12.5px] text-cos-ink-soft">{fmtMoney(e.limiteSugerido)}</span>
                      <span className="text-[12.5px] text-cos-ink-soft">{e.decision ?? "—"}</span>
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
