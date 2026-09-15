"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Opinión de cumplimiento IMSS (OCOFSS) — la última que tenemos y el botón para
// pedir otra. Se pide vía SatGo con sólo el RFC (sin e.firma ni portal); el
// IMSS tarda 1–2 minutos, así que el botón lo dice y espera. El PDF queda
// guardado como acuse (ver /api/cumplimiento/acuse). Vigencia: 30 días.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileText, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Card } from "@/components/ui";
import { formatDate } from "@/lib/utils";

interface Opinion {
  snapshotId: string;
  resultado: string; // POSITIVA | NEGATIVA | NO_LOCALIZADO | SIN_OBLIGACIONES | ERROR
  motivos: string[];
  vigencia: string | null; // YYYY-MM-DD
  fetchedAt: string;
  tieneAcuse: boolean;
}

const ETIQUETA: Record<string, string> = {
  POSITIVA: "Positiva", NEGATIVA: "Negativa", NO_LOCALIZADO: "RFC no localizado",
  SIN_OBLIGACIONES: "Sin opinión · registro patronal en baja", ERROR: "PDF sin interpretar",
};

export default function OpinionImssCard({ companyId }: { companyId: string }) {
  const [opinion, setOpinion] = useState<Opinion | null>(null);
  const [configurado, setConfigurado] = useState(true);
  const [loading, setLoading] = useState(true);
  const [consultando, setConsultando] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/nomina/imss-opinion?companyId=${companyId}`);
      if (res.ok) { const d = await res.json(); setOpinion(d.opinion); setConfigurado(!!d.configurado); }
    } finally { setLoading(false); }
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  async function consultar() {
    setConsultando(true); setMsg("");
    try {
      const res = await fetch("/api/nomina/imss-opinion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(d.error ?? "No se pudo consultar al IMSS"); return; }
      setOpinion(d.opinion);
      setMsg(d.cambio ? `✓ Opinión ${ETIQUETA[d.opinion?.resultado] ?? ""}${d.hallazgos ? ` · ${d.hallazgos} hallazgo${d.hallazgos === 1 ? "" : "s"}` : ""}` : "✓ Sin cambios respecto a la anterior");
    } catch { setMsg("No se pudo consultar al IMSS"); }
    finally { setConsultando(false); }
  }

  if (loading) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  const vencida = !!opinion?.vigencia && opinion.vigencia < hoy;
  const folio = opinion?.motivos.find((m) => m.startsWith("Folio IMSS:"))?.replace("Folio IMSS:", "").trim() ?? null;
  const motivos = opinion?.motivos.filter((m) => !m.startsWith("Folio IMSS:")) ?? [];
  const tono = opinion?.resultado === "POSITIVA" ? "text-cos-jade-ink" : opinion?.resultado === "NEGATIVA" ? "text-cos-red-ink" : "text-cos-amber-ink";
  const Icono = opinion?.resultado === "POSITIVA" ? ShieldCheck : opinion?.resultado === "NEGATIVA" ? ShieldAlert : ShieldQuestion;

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Opinión de cumplimiento IMSS</span>
        {opinion && (
          <span className={`inline-flex items-center gap-1 text-[13px] font-semibold ${tono}`}>
            <Icono className="h-4 w-4" /> {ETIQUETA[opinion.resultado] ?? opinion.resultado}
            {vencida && <span className="ml-1 rounded-full bg-cos-amber-tint px-2 py-0.5 text-[11px] font-semibold text-cos-amber-ink">vencida</span>}
          </span>
        )}
      </div>

      {opinion ? (
        <>
          <p className="mt-2.5 text-[13px] text-cos-ink-soft">
            Obtenida el {formatDate(opinion.fetchedAt)}
            {opinion.vigencia ? (vencida ? ` · venció el ${formatDate(opinion.vigencia)}` : ` · vigente hasta ${formatDate(opinion.vigencia)}`) : ""}
            {folio ? ` · folio ${folio}` : ""}
          </p>
          {motivos.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-cos-ink">
              {motivos.map((m, i) => <li key={i} className="flex gap-1.5"><span className="text-cos-ink-faint">·</span><span>{m}</span></li>)}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-2.5 text-[13px] text-cos-ink-soft">
          Todavía no tenemos la opinión del IMSS de esta empresa. Se pide con el RFC, sin e.firma; el IMSS tarda 1–2 minutos.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-cos-line pt-2.5">
        {opinion?.tieneAcuse && (
          // Al visor in-app, no al PDF crudo: en la PWA instalada abrir el PDF
          // directo deja la pantalla sin "atrás" ni "descargar".
          <Link href={`/opiniones/acuse/${opinion.snapshotId}?doc=imss&volver=/nomina%3Ftab%3Dcumplimiento`}
            className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2.5 py-1 text-[12px] font-semibold text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink">
            <FileText className="h-3.5 w-3.5" /> Ver PDF
          </Link>
        )}
        <button onClick={consultar} disabled={consultando || !configurado}
          title={configurado ? "Pide al IMSS una opinión nueva (1–2 min)" : "Integración SatGo no configurada (SATGO_API_KEY)"}
          className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-3 py-1 text-[12px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
          {consultando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {consultando ? "Consultando al IMSS… tarda 1–2 min" : opinion ? "Pedir opinión nueva" : "Consultar al IMSS"}
        </button>
        {!configurado && <span className="text-[12px] text-cos-ink-faint">Integración SatGo no configurada.</span>}
      </div>
      {msg && <p className={`mt-2 text-[12.5px] ${msg.startsWith("✓") ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>{msg}</p>}
    </Card>
  );
}
