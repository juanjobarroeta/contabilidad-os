"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { Loader2, Wrench, Lock, AlertTriangle, Search, DownloadCloud, Upload } from "lucide-react";

// Operador-only tools: reconcile the system's figures against the SAT filed
// declaración (cross-check), and ingest a company's prior filed declaraciones
// from Syntage (backfill) so the carryover chain fills. Both call operator-gated,
// read-mostly endpoints; non-operators get a 403 (shown as a lock).

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);

// Default to the previous month (the most recent filed period).
function prevPeriodo(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type CompanyOpt = { id: string; rfc: string; razonSocial: string; despachoNombre?: string | null };

export default function OperadorPage() {
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [periodo, setPeriodo] = useState(prevPeriodo());

  // Operador ve TODAS las empresas activas vía /api/companies.
  useEffect(() => {
    fetch("/api/companies")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { if (Array.isArray(list)) setCompanies(list); })
      .catch(() => {});
  }, []);
  const [busy, setBusy] = useState<null | "check" | "backfill">(null);
  const [check, setCheck] = useState<any>(null);
  const [backfill, setBackfill] = useState<any>(null);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");

  async function uploadAcuses(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!companyId) { setError("Selecciona una empresa"); return; }
    setUploading(true); setError(""); setUploadMsg("");
    const msgs: string[] = [];
    try {
      for (const f of Array.from(files)) {
        const b64 = await fileToBase64(f);
        const res = await fetch("/api/operador/ingest-acuse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, pdfBase64: b64 }),
        });
        if (res.status === 403) { setDenied(true); return; }
        const data = await res.json().catch(() => ({}));
        msgs.push(res.ok ? (data.nota ?? `${data.periodo}: ${(data.creados ?? []).join(" + ") || "sin cambios"}`) : `${f.name}: ${data.error ?? "error"}`);
      }
      setUploadMsg(msgs.join("\n"));
    } catch {
      setError("No se pudieron subir los acuses");
    } finally {
      setUploading(false);
    }
  }

  async function call(kind: "check" | "backfill") {
    if (!companyId) { setError("Selecciona una empresa"); return; }
    setBusy(kind); setError(""); setDenied(false);
    try {
      const res =
        kind === "check"
          ? await fetch(`/api/operador/cross-check?companyId=${encodeURIComponent(companyId)}&periodo=${periodo}`)
          : await fetch(`/api/operador/declaraciones-backfill`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyId, year: parseInt(periodo.slice(0, 4)) }),
            });
      if (res.status === 403) { setDenied(true); return; }
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? "Error"); return; }
      if (kind === "check") setCheck(data); else { setBackfill(data); setCheck(null); }
    } catch {
      setError("No se pudo completar la solicitud");
    } finally {
      setBusy(null);
    }
  }

  if (denied) {
    return (
      <div className="mx-auto max-w-[680px] px-6 py-10 text-center">
        <Lock className="mx-auto mb-3 h-10 w-10 text-cos-ink-faint" />
        <p className="text-[15px] font-semibold text-cos-ink">Sólo para operador de plataforma</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[860px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex items-center gap-2.5">
        <Wrench className="h-6 w-6 text-cos-brand" />
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-cos-ink">Herramientas de operador</h1>
      </div>
      <p className="mt-1.5 text-[14px] text-cos-ink-soft">
        Reconcilia contra el SAT e ingresa declaraciones previas para llenar la cadena de arrastre.
      </p>

      <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
          <label className="text-[12.5px] font-medium text-cos-ink-soft">
            Empresa
            <select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="mt-1 w-full rounded-control border border-cos-line bg-white px-3 py-2 text-[14px] focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
            >
              <option value="">Selecciona empresa…</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.razonSocial} — {c.rfc}
                  {c.despachoNombre ? ` · ${c.despachoNombre}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12.5px] font-medium text-cos-ink-soft">
            Periodo
            <input
              type="month"
              value={periodo}
              onChange={(e) => setPeriodo(e.target.value)}
              className="mt-1 w-full rounded-control border border-cos-line px-3 py-2 text-[14px] focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
            />
          </label>
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2.5">
          <button
            onClick={() => call("check")}
            disabled={busy != null}
            className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
          >
            {busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Cross-check (sistema vs SAT)
          </button>
          <button
            onClick={() => call("backfill")}
            disabled={busy != null}
            className="inline-flex items-center gap-2 rounded-control border border-cos-line px-4 py-2 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper disabled:opacity-50"
          >
            {busy === "backfill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            Ingresar declaraciones previas
          </button>
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-cos-red-ink">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        )}

        {/* Fallback cuando Syntage no tiene historial: subir los acuses a mano. */}
        <div className="mt-4 rounded-[12px] border border-dashed border-cos-line bg-cos-paper p-3.5">
          <p className="text-[12.5px] font-medium text-cos-ink">¿Syntage sin datos? Sube los acuses (PDF)</p>
          <p className="mt-0.5 text-[12px] text-cos-ink-soft">
            Para la empresa seleccionada. Se lee el periodo del propio acuse y se guardan las cifras presentadas (gap-fill). Puedes subir varios meses a la vez.
          </p>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-cos-line bg-white px-2.5 py-1.5 text-[13px] hover:bg-cos-paper">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {uploading ? "Leyendo…" : "Subir acuse(s)"}
            <input type="file" accept="application/pdf,.pdf" multiple className="hidden" disabled={uploading || !companyId}
              onChange={(e) => { uploadAcuses(e.target.files); e.target.value = ""; }} />
          </label>
          {uploadMsg && <pre className="mt-2 whitespace-pre-wrap text-[12px] text-cos-ink-soft">{uploadMsg}</pre>}
        </div>
      </Card>

      {/* Cross-check result */}
      {check && (
        <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
          <p className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
            Cross-check · {check.company?.razonSocial} · {check.periodo}
          </p>
          <p className="mt-1 text-[12px] text-cos-ink-faint">
            Facturas: {check.facturas?.emitidas} emitidas · {check.facturas?.recibidas} recibidas
          </p>

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[13px] font-semibold text-cos-ink">IVA</p>
              <Row k="Causado" v={fmt(check.iva?.causado)} />
              <Row k="Acreditable" v={fmt(check.iva?.acreditable)} />
              <Row k="Retenido por clientes" v={fmt(check.iva?.retenidoPorClientes)} />
              <Row k="Saldo a favor anterior" v={fmt(check.iva?.saldoFavorAnterior)} />
              <Row k="A pagar" v={fmt(check.iva?.aPagar)} bold />
              <Row k="Saldo a favor del mes" v={fmt(check.iva?.saldoAFavor)} />
            </div>
            <div>
              <p className="mb-1 text-[13px] font-semibold text-cos-ink">ISR ({check.isr?.metodo})</p>
              <Row k="Ingresos acumulados" v={fmt(check.isr?.ingresosAcumulados)} />
              <Row k={`Coeficiente (${check.isr?.coeficienteFuente})`} v={pct(check.isr?.coeficiente)} />
              <Row k="Coeficiente sugerido" v={pct(check.isr?.coeficienteSugerido)} />
              <Row k="Utilidad fiscal" v={fmt(check.isr?.utilidadFiscal)} />
              <Row k="ISR pagado anterior" v={fmt(check.isr?.isrPagadoAnterior)} />
              <Row k="ISR a pagar" v={fmt(check.isr?.isrPagar)} bold />
            </div>
          </div>

          <ChainStatus chain={check.cadenaPrevia} />
        </Card>
      )}

      {/* Backfill result */}
      {backfill && (
        <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
          <p className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
            Backfill · {backfill.company?.razonSocial}
          </p>
          <p className="mt-2 text-[14px] text-cos-ink">
            {backfill.backfill?.mesesCreados} fila(s) creada(s) · {backfill.backfill?.acusesParseados} acuse(s) leído(s)
            {backfill.backfill?.topeAlcanzado ? " · queda más (vuelve a correr)" : ""}
          </p>
          {backfill.nota && <p className="mt-1 text-[13px] text-cos-ink-soft">{backfill.nota}</p>}

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[13px] font-semibold text-cos-ink">ISR provisional {backfill.cadena?.year}</p>
              {(backfill.cadena?.isrProvisional ?? []).length === 0 ? (
                <p className="text-[13px] text-cos-ink-faint">— ninguno</p>
              ) : (
                backfill.cadena.isrProvisional.map((d: any) => (
                  <Row key={d.periodo} k={d.periodo} v={fmt(d.isrPagar)} />
                ))
              )}
            </div>
            <div>
              <p className="mb-1 text-[13px] font-semibold text-cos-ink">IVA mensual {backfill.cadena?.year}</p>
              {(backfill.cadena?.ivaMensual ?? []).length === 0 ? (
                <p className="text-[13px] text-cos-ink-faint">— ninguno</p>
              ) : (
                backfill.cadena.ivaMensual.map((d: any) => (
                  <Row key={d.periodo} k={d.periodo} v={`${fmt(d.ivaPagar)} · favor ${fmt(d.ivaSaldoFavor)}`} />
                ))
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-cos-line-soft py-1.5 text-[13px] last:border-0">
      <span className="text-cos-ink-soft">{k}</span>
      <span className={bold ? "font-semibold text-cos-ink" : "text-cos-ink"}>{v}</span>
    </div>
  );
}

function ChainStatus({ chain }: { chain: any }) {
  if (!chain) return null;
  const isrFaltan: string[] = chain.isrProvisional?.faltantes ?? [];
  const ivaFaltan: string[] = chain.ivaMensual?.faltantes ?? [];
  const ok = isrFaltan.length === 0 && ivaFaltan.length === 0;
  return (
    <div className={`mt-4 rounded-[10px] border px-3 py-2.5 text-[12.5px] ${ok ? "border-cos-jade/40 bg-cos-jade-tint text-cos-jade-ink" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
      <p className="font-medium">Cadena de arrastre (meses previos del año)</p>
      {ok ? (
        <p className="mt-0.5">Completa — ISR pagado anterior y saldo a favor reflejan lo presentado.</p>
      ) : (
        <p className="mt-0.5">
          Faltan declaraciones previas: {isrFaltan.length > 0 && <>ISR {isrFaltan.join(", ")}. </>}
          {ivaFaltan.length > 0 && <>IVA {ivaFaltan.join(", ")}. </>}
          Corre “Ingresar declaraciones previas”.
        </p>
      )}
    </div>
  );
}
