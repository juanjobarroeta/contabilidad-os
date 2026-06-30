"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Inbox,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  Clock,
  ArrowRight,
  Loader2,
  Building2,
} from "lucide-react";
import { Card, Badge, EmptyState, type BadgeTone } from "@/components/ui";

interface Notificacion {
  id: string;
  companyId: string | null;
  razonSocial: string | null;
  categoria: string;
  severidad: string;
  titulo: string;
  cuerpo: string;
  url: string;
  estado: "NUEVO" | "VISTO" | "HECHO" | "POSPUESTO";
  posponerHasta: string | null;
  createdAt: string;
}

const SEV: Record<string, { tone: BadgeTone; label: string; icon: typeof AlertTriangle; rank: number }> = {
  error: { tone: "danger", label: "Urgente", icon: AlertCircle, rank: 0 },
  warn: { tone: "warning", label: "Atención", icon: AlertTriangle, rank: 1 },
  info: { tone: "info", label: "Informativo", icon: Info, rank: 2 },
};

const CATEGORIA_LABEL: Record<string, string> = {
  briefing: "Briefing",
  estado_cuenta: "Estado de cuenta",
  nomina: "Nómina",
  proyeccion: "Declaración",
  ce: "Contabilidad electrónica",
  otro: "Otro",
};

const fmtFecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short" });

export default function PendientesPage() {
  const [items, setItems] = useState<Notificacion[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/notificaciones");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      setError("No se pudieron cargar tus pendientes.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    setSaving(id);
    try {
      const res = await fetch(`/api/notificaciones/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("No se pudo actualizar el pendiente.");
    } finally {
      setSaving(null);
    }
  }

  // Orden: severidad primero, luego recencia (más nuevo arriba).
  const ordenados = [...(items ?? [])].sort((a, b) => {
    const ra = SEV[a.severidad]?.rank ?? 9;
    const rb = SEV[b.severidad]?.rank ?? 9;
    if (ra !== rb) return ra - rb;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <div>
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">
          Pendientes
        </h1>
        <p className="mt-1.5 max-w-[64ch] text-[15px] text-cos-ink-soft">
          Todo lo que el sistema te avisó, en un solo lugar y a través de tus empresas. Abre cada
          pendiente para atenderlo, márcalo como hecho o posponlo para más tarde.
        </p>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-control bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {items === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando pendientes…
        </div>
      ) : ordenados.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line shadow-card">
          <EmptyState
            icon={Inbox}
            title="No tienes pendientes"
            description="Cuando el sistema detecte algo que requiera tu atención —vencimientos, proyecciones, nómina o conciliaciones— aparecerá aquí."
          />
        </Card>
      ) : (
        <div className="mt-5 space-y-2.5">
          {ordenados.map((n) => (
            <PendienteCard key={n.id} n={n} saving={saving === n.id} onPatch={patch} />
          ))}
        </div>
      )}
    </div>
  );
}

function PendienteCard({
  n,
  saving,
  onPatch,
}: {
  n: Notificacion;
  saving: boolean;
  onPatch: (id: string, body: Record<string, unknown>) => void;
}) {
  const sev = SEV[n.severidad] ?? SEV.info;
  const SevIcon = sev.icon;
  const snoozed = !!n.posponerHasta && new Date(n.posponerHasta) > new Date();

  return (
    <Card className="rounded-card border-cos-line p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <SevIcon
            className={`h-5 w-5 ${
              sev.tone === "danger"
                ? "text-cos-red-ink"
                : sev.tone === "warning"
                  ? "text-cos-amber-ink"
                  : "text-cos-brand-ink"
            }`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={sev.tone}>{sev.label}</Badge>
            <span className="font-mono text-[11.5px] text-cos-ink-faint">
              {CATEGORIA_LABEL[n.categoria] ?? n.categoria}
            </span>
            {n.estado === "NUEVO" && (
              <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 text-[10px] font-semibold text-cos-brand-ink">
                Nuevo
              </span>
            )}
            <span className="ml-auto text-[12px] text-cos-ink-faint">{fmtFecha(n.createdAt)}</span>
          </div>

          <p className="mt-1.5 text-[14px] font-medium text-cos-ink">{n.titulo}</p>
          {n.cuerpo && <p className="mt-1 text-[13px] text-cos-ink-soft">{n.cuerpo}</p>}

          {n.razonSocial && (
            <div className="mt-2 flex items-center gap-1 text-[12px] text-cos-ink-faint">
              <Building2 className="h-3.5 w-3.5" /> {n.razonSocial}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {snoozed ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-cos-ink-faint">
                <Clock className="h-3.5 w-3.5" /> Pospuesto hasta{" "}
                {fmtFecha(n.posponerHasta as string)}
              </span>
            ) : (
              <>
                <Link
                  href={n.url || "#"}
                  onClick={() => onPatch(n.id, { estado: "VISTO" })}
                  className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-cos-brand-deep"
                >
                  Abrir <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <ActionButton
                  disabled={saving}
                  onClick={() => onPatch(n.id, { estado: "HECHO" })}
                  icon={CheckCircle2}
                  variant="primary"
                >
                  Hecho
                </ActionButton>
                <ActionButton
                  disabled={saving}
                  onClick={() => onPatch(n.id, { posponer: "1d" })}
                  icon={Clock}
                  variant="ghost"
                >
                  Posponer 1 día
                </ActionButton>
              </>
            )}
            {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-cos-ink-faint" />}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  icon: Icon,
  variant,
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
