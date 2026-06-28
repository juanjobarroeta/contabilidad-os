"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ShieldCheck, FileDown, AlertTriangle, Info, RefreshCw, FileText,
} from "lucide-react";
import { Card, Badge, type BadgeTone, PageContainer, PageHeader, Loading, EmptyState, Alert } from "@/components/ui";
import { CumplimientoTabs } from "@/components/layout/CumplimientoTabs";

// Mirrors the GET /api/cumplimiento response.
interface CumplimientoEmpresa {
  companyId: string;
  razonSocial: string;
  rfc: string;
  sat: {
    snapshotId: string; resultado: string; folio: string | null; motivos: string[];
    vigencia: string | null; fetchedAt: string; tieneAcuse: boolean;
  } | null;
  csf: {
    snapshotId: string; estatusPadron: string; regimenes: string[];
    obligacionesCount: number; codigoPostal: string | null; fetchedAt: string; tieneAcuse: boolean;
  } | null;
  hallazgos: { id: string; checkClave: string; severidad: string; mensaje: string; sugerencia: string }[];
}

const OPINION_TONE: Record<string, BadgeTone> = {
  POSITIVA: "success", NEGATIVA: "danger", NO_LOCALIZADO: "warning",
  SIN_OBLIGACIONES: "info", ERROR: "neutral",
};
const OPINION_LABEL: Record<string, string> = {
  POSITIVA: "Positiva", NEGATIVA: "Negativa", NO_LOCALIZADO: "No localizado",
  SIN_OBLIGACIONES: "Sin obligaciones", ERROR: "Error",
};
const ESTATUS_TONE: Record<string, BadgeTone> = {
  ACTIVO: "success", SUSPENDIDO: "warning", CANCELADO: "danger", BAJA: "danger", DESCONOCIDO: "neutral",
};
const SEV_TONE: Record<string, BadgeTone> = { error: "danger", warn: "warning", info: "info" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export default function OpinionesPage() {
  const [empresas, setEmpresas] = useState<CumplimientoEmpresa[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cumplimiento");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setEmpresas(data.empresas ?? []);
    } catch {
      setError("No se pudo cargar el panorama de cumplimiento.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const conNegativa = empresas?.filter((e) => e.sat?.resultado === "NEGATIVA").length ?? 0;
  const conHallazgos = empresas?.filter((e) => e.hallazgos.length > 0).length ?? 0;

  return (
    <PageContainer>
      <CumplimientoTabs />
      <PageHeader
        title="Opiniones y constancias"
        subtitle="Opinión de cumplimiento (SAT 32-D) y Constancia de Situación Fiscal por empresa, con su acuse."
        actions={
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium hover:bg-cos-paper disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Actualizar
          </button>
        }
      />

      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

      {empresas === null ? (
        <Loading label="Cargando cumplimiento…" />
      ) : empresas.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Sin datos de cumplimiento"
          description="Aún no hay opiniones ni constancias monitoreadas para tus empresas."
        />
      ) : (
        <div className="space-y-4">
          {(conNegativa > 0 || conHallazgos > 0) && (
            <div className="flex flex-wrap gap-2">
              {conNegativa > 0 && (
                <Badge tone="danger">{conNegativa} con opinión negativa</Badge>
              )}
              {conHallazgos > 0 && (
                <Badge tone="warning">{conHallazgos} con alertas de cumplimiento</Badge>
              )}
            </div>
          )}

          {empresas.map((e) => (
            <EmpresaCard key={e.companyId} e={e} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function EmpresaCard({ e }: { e: CumplimientoEmpresa }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-cos-ink">{e.razonSocial}</h3>
          <p className="font-mono text-[12.5px] text-cos-ink-soft">{e.rfc}</p>
        </div>
        {e.sat && (
          <Badge tone={OPINION_TONE[e.sat.resultado] ?? "neutral"}>
            Opinión {OPINION_LABEL[e.sat.resultado] ?? e.sat.resultado}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 gap-px bg-cos-line sm:grid-cols-2">
        {/* SAT opinion */}
        <Section title="Opinión de cumplimiento (32-D)" icon={ShieldCheck}>
          {e.sat ? (
            <div className="space-y-1.5 text-[13px]">
              {e.sat.folio && (
                <Row label="Folio SAT" value={<span className="font-mono">{e.sat.folio}</span>} />
              )}
              {e.sat.vigencia && <Row label="Vigencia" value={fmtDate(e.sat.vigencia)} />}
              <Row label="Consultado" value={fmtDate(e.sat.fetchedAt)} />
              <AcuseLink snapshotId={e.sat.snapshotId} tieneAcuse={e.sat.tieneAcuse} />
            </div>
          ) : (
            <p className="text-[13px] text-cos-ink-faint">Sin opinión monitoreada.</p>
          )}
        </Section>

        {/* CSF */}
        <Section title="Constancia de Situación Fiscal" icon={FileText}>
          {e.csf ? (
            <div className="space-y-1.5 text-[13px]">
              <Row
                label="Estatus padrón"
                value={<Badge tone={ESTATUS_TONE[e.csf.estatusPadron] ?? "neutral"}>{e.csf.estatusPadron}</Badge>}
              />
              <Row
                label="Régimen(es)"
                value={e.csf.regimenes.length ? e.csf.regimenes.join(", ") : "—"}
              />
              <Row label="Obligaciones" value={`${e.csf.obligacionesCount}`} />
              {e.csf.codigoPostal && <Row label="C.P." value={e.csf.codigoPostal} />}
              <Row label="Consultado" value={fmtDate(e.csf.fetchedAt)} />
              <AcuseLink snapshotId={e.csf.snapshotId} tieneAcuse={e.csf.tieneAcuse} />
            </div>
          ) : (
            <p className="text-[13px] text-cos-ink-faint">Sin constancia monitoreada.</p>
          )}
        </Section>
      </div>

      {e.hallazgos.length > 0 && (
        <div className="border-t border-cos-line bg-cos-paper px-5 py-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-cos-ink">
            <AlertTriangle className="h-3.5 w-3.5 text-cos-amber-ink" />
            Alertas de cumplimiento
          </p>
          <ul className="space-y-2">
            {e.hallazgos.map((h) => (
              <li key={h.id} className="flex items-start gap-2 text-[13px]">
                <Badge tone={SEV_TONE[h.severidad] ?? "neutral"} className="mt-0.5 shrink-0">
                  {h.severidad}
                </Badge>
                <div>
                  <p className="text-cos-ink">{h.mensaje}</p>
                  {h.sugerencia && <p className="mt-0.5 text-cos-ink-soft">{h.sugerencia}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof ShieldCheck; children: React.ReactNode }) {
  return (
    <div className="bg-cos-card px-5 py-4">
      <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
        <Icon className="h-3.5 w-3.5" /> {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-cos-ink-faint">{label}</span>
      <span className="text-right text-cos-ink">{value}</span>
    </div>
  );
}

function AcuseLink({ snapshotId, tieneAcuse }: { snapshotId: string; tieneAcuse: boolean }) {
  if (!tieneAcuse) {
    return (
      <p className="flex items-center gap-1.5 pt-1 text-[12px] text-cos-ink-faint">
        <Info className="h-3.5 w-3.5" /> Sin acuse de respaldo
      </p>
    );
  }
  return (
    <Link
      href={`/opiniones/acuse/${snapshotId}`}
      className="inline-flex items-center gap-1.5 pt-1 text-[13px] font-semibold text-cos-brand-ink hover:underline"
    >
      <FileDown className="h-3.5 w-3.5" /> Ver acuse
    </Link>
  );
}
