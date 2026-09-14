"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FICHA «HISTORIA» DEL RESOLVER — qué le pasó a este movimiento y POR QUÉ.
//
// Las otras fichas cuentan el estado final. Ésta cuenta cómo se llegó a él: las
// decisiones del motor con sus reglas en palabras, mezcladas con lo que hicieron
// las personas. Es la ficha que contesta «¿por qué quedó casado con ESA
// factura?» sin tener que reconstruir el mes a mano.
//
// Se carga PEREZOSAMENTE, al abrirla: la mesa se recorre movimiento por
// movimiento y una consulta más por selección se paga en cada clic, aunque casi
// nadie abra la historia. Una vez cargada se queda: volver a cerrarla y abrirla
// no vuelve a consultar.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[.08em] text-cos-ink-faint";

interface RazonDecision {
  regla: string;
  detalle: string;
  score?: number;
  candidatoId?: string;
}

interface EventoHistoria {
  id: string;
  fecha: string;
  origen: "motor" | "persona";
  autor: string;
  titulo: string;
  razones: RazonDecision[];
  datos: unknown;
}

const fechaHora = (d: string) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime())
    ? d
    : x.toLocaleString("es-MX", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

/**
 * Las reglas que valen un color propio.
 *
 * `sin-identidad` es la del fallo de agosto: un match aplicado sin saber quién
 * es la contraparte, sólo porque el importe coincidía. Que salte a la vista es
 * el punto de toda la ficha.
 */
function claseDeRegla(regla: string): string {
  if (regla === "conciliacion.sin-identidad") return "bg-cos-red-tint text-cos-red-ink";
  if (regla.startsWith("conciliacion.identidad") || regla === "conciliacion.aplicada")
    return "bg-cos-jade-tint text-cos-jade-ink";
  if (regla.startsWith("terminal.")) return "bg-cos-amber-tint text-cos-amber-ink";
  return "bg-cos-slate-tint text-cos-ink-soft";
}

function Evento({ e }: { e: EventoHistoria }) {
  return (
    <li className="border-t border-cos-line-soft px-4 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-semibold text-cos-ink">{e.titulo}</span>
        <span className="text-[11.5px] text-cos-ink-faint">
          {e.origen === "motor" ? "motor" : "persona"} · {e.autor}
        </span>
        <span className="ml-auto font-mono text-[11.5px] tabular-nums text-cos-ink-faint">{fechaHora(e.fecha)}</span>
      </div>
      {e.razones.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {e.razones.map((r, i) => (
            <li key={`${r.regla}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className={`rounded-full px-2 py-px text-[10.5px] font-semibold ${claseDeRegla(r.regla)}`}>
                {r.regla}
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] text-cos-ink-soft">{r.detalle}</span>
              {r.score != null && (
                <span className="font-mono text-[11.5px] tabular-nums text-cos-ink-faint">{r.score}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function FichaHistoria({ txId }: { txId: string }) {
  const [abierta, setAbierta] = useState(false);
  const [eventos, setEventos] = useState<EventoHistoria[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abrir = useCallback(async () => {
    const siguiente = !abierta;
    setAbierta(siguiente);
    if (!siguiente || eventos || cargando) return;
    setCargando(true);
    setError(null);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}/historia`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudo leer la historia");
      setEventos(data.eventos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer la historia");
    } finally {
      setCargando(false);
    }
  }, [abierta, eventos, cargando, txId]);

  return (
    <section className="rounded-card border border-cos-line bg-cos-card shadow-card">
      <button
        type="button"
        onClick={abrir}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <p className={EYEBROW}>Historia</p>
        <span className="text-[12px] text-cos-ink-faint">
          {abierta ? "ocultar" : "por qué quedó así"}
        </span>
      </button>

      {abierta && (
        <div className="border-t border-cos-line-soft">
          {cargando && <p className="px-4 py-2.5 text-[12.5px] text-cos-ink-faint">Leyendo…</p>}
          {error && <p className="px-4 py-2.5 text-[12.5px] text-cos-red-ink">{error}</p>}
          {eventos && eventos.length === 0 && (
            <p className="px-4 py-2.5 text-[12.5px] text-cos-ink-faint">
              Nadie ha tocado este movimiento todavía, ni el motor ni una persona.
            </p>
          )}
          {eventos && eventos.length > 0 && (
            <ul className="-mt-px">
              {eventos.map((e) => (
                <Evento key={e.id} e={e} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
