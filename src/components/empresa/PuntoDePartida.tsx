"use client";

// ─────────────────────────────────────────────────────────────────────────────
// La tarjeta «Punto de partida» de /empresa: seis cosas que una empresa
// necesita para que su contabilidad sea real, con lo que hay, lo que falta y
// qué archivo pedirle. Se esconde sola cuando todo está listo: no es un panel,
// es una lista de pendientes de arranque.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleDashed, AlertCircle, Loader2 } from "lucide-react";
import type { PuntoDePartida as Resultado, PasoPuntoDePartida } from "@/lib/empresa/punto-de-partida";
import { cn } from "@/lib/utils";

const ESTILO: Record<PasoPuntoDePartida["estado"], { icono: typeof CheckCircle2; cls: string; chip: string }> = {
  listo: { icono: CheckCircle2, cls: "text-cos-jade-ink", chip: "" },
  parcial: { icono: CircleDashed, cls: "text-cos-amber-ink", chip: "En proceso" },
  falta: { icono: AlertCircle, cls: "text-cos-red-ink", chip: "Falta" },
};

export function PuntoDePartida({ companyId }: { companyId: string }) {
  const [r, setR] = useState<Resultado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ejecutando, setEjecutando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tono: "ok" | "error"; texto: string } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    fetch(`/api/empresa/punto-de-partida?companyId=${companyId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (vivo) setR(d && Array.isArray(d.pasos) ? d : null); })
      .catch(() => { if (vivo) setR(null); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [companyId, version]);

  async function ejecutar(p: PasoPuntoDePartida) {
    if (!p.accion) return;
    setEjecutando(p.clave); setAviso(null);
    try {
      const res = await fetch("/api/contabilidad/apertura/desde-ce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, anio: p.accion.anio, mes: p.accion.mes }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo generar la apertura");
      const total = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(d?.balanza?.totalCargos ?? 0);
      setAviso({ tono: "ok", texto: `Apertura generada: ${d?.balanza?.entries ?? 0} partida(s) por ${total}.` });
      setVersion((v) => v + 1);
    } catch (e) {
      setAviso({ tono: "error", texto: e instanceof Error ? e.message : "No se pudo generar la apertura" });
    } finally {
      setEjecutando(null);
    }
  }

  if (cargando) {
    return (
      <div className="mb-5 flex items-center gap-2 text-xs text-cos-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando el punto de partida…
      </div>
    );
  }
  if (!r || (r.listos === r.total && !aviso)) return null;

  const enlace = (p: PasoPuntoDePartida, children: React.ReactNode) =>
    p.href.startsWith("#") ? (
      <a href={p.href} className="text-[12px] font-medium text-cos-brand-ink underline-offset-2 hover:underline">{children}</a>
    ) : (
      <Link href={p.href} className="text-[12px] font-medium text-cos-brand-ink underline-offset-2 hover:underline">{children}</Link>
    );

  return (
    <section className="mb-5 rounded-xl border border-cos-line bg-cos-card p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-cos-ink">Punto de partida · {r.listos} de {r.total}</h2>
        {r.siguiente && (
          <span className="text-xs text-cos-ink-soft">
            Siguiente: <span className="font-medium text-cos-ink">{r.siguiente.titulo}</span>
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-cos-ink-soft">
        Con la e.firma bajamos del SAT los CFDI y la Contabilidad Electrónica; lo demás se pide una vez y en el formato que tengas.
      </p>
      {aviso && (
        <p className={cn("mb-3 rounded-md px-3 py-2 text-[12px]", aviso.tono === "ok" ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-red-tint text-cos-red-ink")}>{aviso.texto}</p>
      )}
      <ul className="divide-y divide-cos-line-soft">
        {r.pasos.map((p) => {
          const e = ESTILO[p.estado];
          const Icono = e.icono;
          return (
            <li key={p.clave} className="flex items-start gap-3 py-2.5">
              <Icono className={cn("mt-0.5 h-4 w-4 shrink-0", e.cls)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium text-cos-ink">{p.titulo}</span>
                  <span className="text-[12px] text-cos-ink-soft">{p.detalle}</span>
                  {e.chip && (
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold", p.estado === "falta" ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-amber-tint text-cos-amber-ink")}>
                      {e.chip}
                    </span>
                  )}
                </div>
                {p.peticion && <p className="mt-0.5 text-[12px] text-cos-ink">{p.peticion}</p>}
              </div>
              {p.accion ? (
                <button
                  onClick={() => ejecutar(p)}
                  disabled={ejecutando !== null}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[12px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                >
                  {ejecutando === p.clave && <Loader2 className="h-3 w-3 animate-spin" />}
                  {p.accion.etiqueta}
                </button>
              ) : (
                p.estado !== "listo" && <div className="shrink-0 pt-0.5">{enlace(p, "Resolver →")}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
