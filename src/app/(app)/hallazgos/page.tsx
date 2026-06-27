"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ScanSearch, AlertTriangle, AlertCircle, Info, CheckCircle2, EyeOff,
  RotateCcw, Loader2, ScrollText, FileText, ArrowRight,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Badge, type BadgeTone } from "@/components/ui";
import { ctaParaHallazgo } from "@/lib/hallazgos-cta";

interface Hallazgo {
  id: string;
  checkClave: string;
  categoria: string;
  severidad: string;
  mensaje: string;
  sugerencia: string;
  fundamento: { ley: string; articulo: string; fraccion: string | null };
  referencias: string[];
  estado: string;
  createdAt: string;
  updatedAt: string;
}
type Estado = "ABIERTO" | "RESUELTO" | "IGNORADO";

const SEV: Record<string, { tone: BadgeTone; label: string; icon: typeof AlertTriangle; rank: number }> = {
  error: { tone: "danger", label: "Error", icon: AlertCircle, rank: 0 },
  warn: { tone: "warning", label: "Advertencia", icon: AlertTriangle, rank: 1 },
  info: { tone: "info", label: "Informativo", icon: Info, rank: 2 },
};
const CATEGORIA_LABEL: Record<string, string> = {
  cumplimiento: "Cumplimiento SAT / IMSS",
  efos: "Proveedores 69-B (EFOS)",
  isn: "ISN — nómina estatal",
  cfdi: "CFDI / comprobantes",
  deduccion: "Deducciones",
  isr: "ISR",
  iva: "IVA",
  otros: "Otros",
};
const catLabel = (c: string) => CATEGORIA_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1);

const TABS: { key: Estado; label: string }[] = [
  { key: "ABIERTO", label: "Abiertos" },
  { key: "RESUELTO", label: "Resueltos" },
  { key: "IGNORADO", label: "Ignorados" },
];

export default function HallazgosPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<Estado>("ABIERTO");
  const [hallazgos, setHallazgos] = useState<Hallazgo[] | null>(null);
  const [resumen, setResumen] = useState<Record<string, number>>({ ABIERTO: 0, RESUELTO: 0, IGNORADO: 0 });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setHallazgos(null);
    setError("");
    try {
      const res = await fetch(`/api/hallazgos?companyId=${activeCompany.id}&estado=${tab}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setHallazgos(data.hallazgos ?? []);
      setResumen(data.resumen ?? { ABIERTO: 0, RESUELTO: 0, IGNORADO: 0 });
    } catch {
      setError("No se pudieron cargar los hallazgos.");
      setHallazgos([]);
    }
  }, [activeCompany, tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function setEstado(id: string, estado: Estado) {
    setSaving(id);
    try {
      const res = await fetch(`/api/hallazgos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("No se pudo actualizar el hallazgo.");
    } finally {
      setSaving(null);
    }
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa para ver sus hallazgos.</div>;
  }

  // Group by categoria, severity-ranked within each group.
  const grupos = new Map<string, Hallazgo[]>();
  for (const h of hallazgos ?? []) {
    const arr = grupos.get(h.categoria) ?? [];
    arr.push(h);
    grupos.set(h.categoria, arr);
  }
  for (const arr of grupos.values()) {
    arr.sort((a, b) => (SEV[a.severidad]?.rank ?? 9) - (SEV[b.severidad]?.rank ?? 9));
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <div>
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Hallazgos del auditor</h1>
        <p className="mt-1.5 text-[14px] font-medium text-cos-brand-ink">
          {activeCompany.razonSocial} · <span className="font-mono text-cos-ink-soft">{activeCompany.rfc}</span>
        </p>
        <p className="mt-1 max-w-[64ch] text-[15px] text-cos-ink-soft">
          Riesgos detectados en CFDIs, deducciones, ISN y proveedores 69-B. Resuelve un hallazgo cuando lo
          atiendas o acredites materialidad, o ignóralo si no aplica — tu decisión persiste entre revisiones.
        </p>
      </div>

      {/* tabs */}
      <div className="mt-5 flex gap-1 border-b border-cos-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`relative px-3.5 py-2 text-[14px] font-medium transition-colors ${
              tab === t.key ? "text-cos-ink" : "text-cos-ink-faint hover:text-cos-ink-soft"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${tab === t.key ? "bg-cos-ink text-white" : "bg-cos-slate-tint text-cos-ink-soft"}`}>
              {resumen[t.key] ?? 0}
            </span>
            {tab === t.key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-cos-ink" />}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-control bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {hallazgos === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando hallazgos…
        </div>
      ) : hallazgos.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line p-10 text-center shadow-card">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-cos-jade-ink opacity-50" />
          <p className="text-sm font-medium text-cos-ink">
            {tab === "ABIERTO" ? "Sin hallazgos abiertos" : tab === "RESUELTO" ? "Nada resuelto todavía" : "Nada ignorado"}
          </p>
          <p className="mt-1 text-xs text-cos-ink-soft">
            {tab === "ABIERTO"
              ? "El auditor no detectó riesgos pendientes para esta empresa."
              : "Los hallazgos que marques aparecerán aquí."}
          </p>
        </Card>
      ) : (
        <div className="mt-5 space-y-5">
          {[...grupos.entries()].map(([categoria, items]) => (
            <div key={categoria}>
              <div className="mb-2 flex items-center gap-2">
                <ScanSearch className="h-4 w-4 text-cos-ink-faint" />
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
                  {catLabel(categoria)}
                </h2>
                <span className="text-[12px] text-cos-ink-faint">· {items.length}</span>
              </div>
              <div className="space-y-2.5">
                {items.map((h) => (
                  <HallazgoCard key={h.id} h={h} saving={saving === h.id} onSetEstado={setEstado} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HallazgoCard({
  h, saving, onSetEstado,
}: {
  h: Hallazgo;
  saving: boolean;
  onSetEstado: (id: string, estado: Estado) => void;
}) {
  const sev = SEV[h.severidad] ?? SEV.info;
  const SevIcon = sev.icon;
  const fundamento = [h.fundamento.ley, h.fundamento.articulo && `Art. ${h.fundamento.articulo}`, h.fundamento.fraccion && `Fr. ${h.fundamento.fraccion}`]
    .filter(Boolean)
    .join(" ");
  const cta = h.estado === "ABIERTO" ? ctaParaHallazgo(h.checkClave) : null;

  return (
    <Card className="rounded-card border-cos-line p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <SevIcon className={`h-5 w-5 ${sev.tone === "danger" ? "text-cos-red-ink" : sev.tone === "warning" ? "text-cos-amber-ink" : "text-cos-brand-ink"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={sev.tone}>{sev.label}</Badge>
            <span className="font-mono text-[11.5px] text-cos-ink-faint">{h.checkClave}</span>
          </div>
          <p className="mt-1.5 text-[14px] font-medium text-cos-ink">{h.mensaje}</p>
          {h.sugerencia && <p className="mt-1 text-[13px] text-cos-ink-soft">{h.sugerencia}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-cos-ink-faint">
            {fundamento && (
              <span className="inline-flex items-center gap-1">
                <ScrollText className="h-3.5 w-3.5" /> {fundamento}
              </span>
            )}
            {h.referencias.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3.5 w-3.5" /> {h.referencias.length} CFDI{h.referencias.length > 1 ? "s" : ""} referenciado{h.referencias.length > 1 ? "s" : ""}
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {h.estado === "ABIERTO" ? (
              <>
                {cta && (
                  <Link
                    href={cta.href}
                    className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-cos-brand-deep"
                  >
                    {cta.label} <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                )}
                <ActionButton disabled={saving} onClick={() => onSetEstado(h.id, "RESUELTO")} icon={CheckCircle2} variant="primary">
                  Marcar resuelto
                </ActionButton>
                <ActionButton disabled={saving} onClick={() => onSetEstado(h.id, "IGNORADO")} icon={EyeOff} variant="ghost">
                  Ignorar
                </ActionButton>
              </>
            ) : (
              <ActionButton disabled={saving} onClick={() => onSetEstado(h.id, "ABIERTO")} icon={RotateCcw} variant="ghost">
                Reabrir
              </ActionButton>
            )}
            {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-cos-ink-faint" />}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActionButton({
  children, onClick, disabled, icon: Icon, variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  icon: typeof CheckCircle2;
  variant: "primary" | "ghost";
}) {
  const cls =
    variant === "primary"
      ? "border-transparent bg-cos-jade text-white hover:opacity-90"
      : "border-cos-line bg-white text-cos-ink hover:bg-cos-paper";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-50 ${cls}`}
    >
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  );
}
