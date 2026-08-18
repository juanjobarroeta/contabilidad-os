"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ScanSearch, AlertTriangle, AlertCircle, Info, CheckCircle2, EyeOff,
  RotateCcw, Loader2, ScrollText, FileText, ArrowRight, Clock, ChevronDown,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { CumplimientoTabs } from "@/components/layout/CumplimientoTabs";
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
  posponerHasta: string | null;
  createdAt: string;
  updatedAt: string;
}
type Estado = "ABIERTO" | "RESUELTO" | "IGNORADO";
type Filtro = Estado | "POSPUESTO";

interface BriefGrupo {
  clave: string;
  severidad: string;
  n: number;
  fundamento: string;
  accion: string;
  ejemplos: string[];
}
interface Brief {
  resumen: string;
  grupos: BriefGrupo[];
  hallazgosAbiertos: number;
  generadoAt: string;
}

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

const TABS: { key: Filtro; label: string }[] = [
  { key: "ABIERTO", label: "Abiertos" },
  { key: "POSPUESTO", label: "Pospuestos" },
  { key: "RESUELTO", label: "Resueltos" },
  { key: "IGNORADO", label: "Ignorados" },
];

const fmtFechaCorta = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short" }) : "";

export default function HallazgosPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<Filtro>("ABIERTO");
  const [hallazgos, setHallazgos] = useState<Hallazgo[] | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [resumen, setResumen] = useState<Record<string, number>>({ ABIERTO: 0, POSPUESTO: 0, RESUELTO: 0, IGNORADO: 0 });
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
      setBrief(data.brief ?? null);
      setResumen(data.resumen ?? { ABIERTO: 0, POSPUESTO: 0, RESUELTO: 0, IGNORADO: 0 });
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

  async function posponer(id: string, token: "7d" | "30d" | "fin_de_mes") {
    setSaving(id);
    try {
      const res = await fetch(`/api/hallazgos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posponer: token }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("No se pudo posponer el hallazgo.");
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
      <CumplimientoTabs />
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
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${tab === t.key ? "bg-cos-ink text-cos-canvas" : "bg-cos-slate-tint text-cos-ink-soft"}`}>
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

      {/* Lectura del auditor: la síntesis priorizada de TODO lo abierto —
          qué atender primero, qué cae en lote con una sola acción. La lista
          granular sigue abajo; esto es el mapa para no perderse en ella. */}
      {tab === "ABIERTO" && brief && brief.hallazgosAbiertos > 0 && hallazgos !== null && hallazgos.length > 0 && (
        <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-cos-ink">Lectura del auditor</span>
            <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 text-[11px] font-medium text-cos-brand-ink">
              {brief.hallazgosAbiertos} hallazgo(s) en {brief.grupos.length} grupo(s) · {fmtFechaCorta(brief.generadoAt)}
              {brief.hallazgosAbiertos !== (resumen.ABIERTO ?? 0) ? " · desactualizada, corre el auditor" : ""}
            </span>
          </div>
          {brief.resumen && (
            <div className="space-y-1.5">
              {brief.resumen.split("\n").filter((l) => l.trim()).map((linea, i) => {
                const t = linea.trim();
                const encabezado = /^\*\*(.+)\*\*$/.exec(t);
                const vineta = /^[-•]\s+(.*)$/.exec(t);
                const cuerpo = (vineta ? vineta[1] : t).replace(/\*\*(.+?)\*\*/g, "$1");
                return encabezado ? (
                  <p key={i} className="pt-1 text-[12.5px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
                    {encabezado[1]}
                  </p>
                ) : (
                  <p key={i} className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                    {vineta ? "· " : ""}{cuerpo}
                  </p>
                );
              })}
            </div>
          )}
          {/* Grupos deterministas: el conteo por causa raíz aunque la narrativa falle. */}
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-cos-line-soft pt-3">
            {brief.grupos.map((g) => (
              <span
                key={g.clave}
                title={`${g.accion} (${g.fundamento})`}
                className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ${
                  g.severidad === "error"
                    ? "bg-cos-red-tint text-cos-red-ink"
                    : g.severidad === "warn"
                      ? "bg-cos-amber-tint text-cos-amber-ink"
                      : "bg-cos-slate-tint text-cos-ink-soft"
                }`}
              >
                {catLabel(g.clave.split(".")[0] || "otros")} · {g.clave.split(".").slice(1).join(".") || g.clave} <b>{g.n}</b>
              </span>
            ))}
          </div>
        </Card>
      )}

      {hallazgos === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando hallazgos…
        </div>
      ) : hallazgos.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line p-10 text-center shadow-card">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-cos-jade-ink opacity-50" />
          <p className="text-sm font-medium text-cos-ink">
            {tab === "ABIERTO" ? "Sin hallazgos abiertos" : tab === "POSPUESTO" ? "Nada pospuesto" : tab === "RESUELTO" ? "Nada resuelto todavía" : "Nada ignorado"}
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
                  <HallazgoCard key={h.id} h={h} saving={saving === h.id} onSetEstado={setEstado} onPosponer={posponer} />
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
  h, saving, onSetEstado, onPosponer,
}: {
  h: Hallazgo;
  saving: boolean;
  onSetEstado: (id: string, estado: Estado) => void;
  onPosponer: (id: string, token: "7d" | "30d" | "fin_de_mes") => void;
}) {
  const sev = SEV[h.severidad] ?? SEV.info;
  const SevIcon = sev.icon;
  const fundamento = [h.fundamento.ley, h.fundamento.articulo && `Art. ${h.fundamento.articulo}`, h.fundamento.fraccion && `Fr. ${h.fundamento.fraccion}`]
    .filter(Boolean)
    .join(" ");
  const snoozed = !!h.posponerHasta && new Date(h.posponerHasta) > new Date();
  const cta = h.estado === "ABIERTO" && !snoozed ? ctaParaHallazgo(h.checkClave) : null;

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

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {snoozed ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-cos-ink-faint">
                  <Clock className="h-3.5 w-3.5" /> Pospuesto hasta {fmtFechaCorta(h.posponerHasta)}
                </span>
                <ActionButton disabled={saving} onClick={() => onSetEstado(h.id, "ABIERTO")} icon={RotateCcw} variant="ghost">
                  Reactivar
                </ActionButton>
              </>
            ) : h.estado === "ABIERTO" ? (
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
                <PosponerMenu disabled={saving} onPick={(t) => onPosponer(h.id, t)} />
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
      : "border-cos-line bg-cos-card text-cos-ink hover:bg-cos-paper";
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

function PosponerMenu({ disabled, onPick }: { disabled: boolean; onPick: (t: "7d" | "30d" | "fin_de_mes") => void }) {
  const [open, setOpen] = useState(false);
  const opciones: { t: "7d" | "30d" | "fin_de_mes"; label: string }[] = [
    { t: "7d", label: "7 días" },
    { t: "30d", label: "30 días" },
    { t: "fin_de_mes", label: "Fin de mes" },
  ];
  return (
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] font-semibold text-cos-ink transition-colors hover:bg-cos-paper disabled:opacity-50"
      >
        <Clock className="h-3.5 w-3.5" /> Posponer <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 z-20 mt-1 min-w-[150px] overflow-hidden rounded-control border border-cos-line bg-cos-card py-1 shadow-card">
            {opciones.map((o) => (
              <button
                key={o.t}
                onClick={() => {
                  setOpen(false);
                  onPick(o.t);
                }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-cos-ink hover:bg-cos-paper"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
