"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, ChevronDown, Pause, Play, Settings2 } from "lucide-react";
import { OBJECTIVE_LABELS, type ObjectiveState } from "@/lib/contabot/objectives/decision";
import { ORDEN_PASOS } from "@/lib/cierre/claves";

interface Objective {
  id: string; title: string; year: number; month: number; state: ObjectiveState; version: number;
  responsibleUserId: string; conversationId: string | null; nextAction: string; lastError: string | null;
  dueDate: string | null; lastCheckedAt: string | null; pausedAt: string | null;
  runs: Array<{ id: string; state: string; createdAt: string; completedAt: string | null; error: string | null }>;
}
interface Queue {
  available: boolean; permissions: { canWrite: boolean; canManage: boolean }; userId: string; defaultPeriod: string;
  responsibleUsers: Array<{ id: string; label: string }>;
  mandate: { enabled: boolean; responsibleUserId: string; maxRunsPerDay: number; startPeriod: string; lastError: string | null } | null;
  objectives: Objective[];
}
const BUTTON = "inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[12px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50";
const INPUT = "w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13px] text-cos-ink";
const SCOPE_LABELS: Record<string, string> = { cierre: "Cierre completo", apertura: "Punto de partida", sat: "Documentos SAT", nomina: "Nómina", imss: "IMSS", banco: "Conciliación bancaria", complementos: "Complementos", impuestos: "Impuestos", contabilidad: "Contabilidad", revision: "Revisión", diot: "DIOT", declaracion: "Declaración", entregables: "Entregables" };

/** Company/period changes remount the queue and discard stale responses/forms. */
export function ContaBotWorkPanel(props: { companyId: string; period?: string }) {
  return <WorkPanel key={`${props.companyId}:${props.period ?? "all"}`} {...props} />;
}

function WorkPanel({ companyId, period }: { companyId: string; period?: string }) {
  const [data, setData] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"assign" | "configure" | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(period ?? "");
  const [scope, setScope] = useState("cierre");
  const [instructions, setInstructions] = useState("");
  const [responsible, setResponsible] = useState("");
  const [limit, setLimit] = useState(3);
  const [recurring, setRecurring] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ companyId, ...(period ? { period } : {}) });
    const response = await fetch(`/api/ai/contabot/objectives?${query}`, { signal, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "No se pudo consultar el trabajo de ContaBot.");
    if (!signal?.aborted) setData(result);
  }, [companyId, period]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void load(controller.signal).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [load]);

  async function mutate(input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/ai/contabot/objectives", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, companyId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar.");
      setForm(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar."); }
    finally { setBusy(false); }
  }
  function openForm(kind: "assign" | "configure") {
    setError(null); setForm(kind);
    setSelectedPeriod(kind === "configure" ? data?.mandate?.startPeriod ?? data?.defaultPeriod ?? "" : period ?? data?.defaultPeriod ?? "");
    setResponsible(data?.mandate?.responsibleUserId ?? data?.userId ?? "");
    setLimit(data?.mandate?.maxRunsPerDay ?? 3); setRecurring(data?.mandate?.enabled ?? false);
  }
  if (!data) return error ? <p role="alert" className="mb-3 text-[12px] text-cos-red-ink">{error}</p> : null;
  if (!data.available && !data.objectives.length) return null;
  const visible = data.objectives.filter((o) => showHistory || !["completed", "paused"].includes(o.state));
  const hidden = data.objectives.length - visible.length;
  return (
    <section aria-label="Objetivos de ContaBot" className="mb-5 rounded-card border border-cos-line bg-cos-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink"><Bot className="h-4 w-4 text-cos-brand" /> Trabajo de ContaBot</h2>
          <p className="mt-1 text-[12px] text-cos-ink-soft">{data.mandate?.enabled ? "Responsabilidad mensual activa" : "Objetivos por encargo"} · {data.mandate?.maxRunsPerDay ?? 3} revisiones automáticas al día como máximo.</p>
        </div>
        <div className="flex gap-2">
          {data.available && data.permissions.canWrite && <button className={BUTTON} onClick={() => openForm("assign")}>Asignar objetivo</button>}
          {data.permissions.canManage && <button className={BUTTON} onClick={() => openForm("configure")} aria-label="Gestionar responsabilidad de ContaBot"><Settings2 className="h-3.5 w-3.5" /> Gestionar</button>}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-cos-red-ink">{error}</p>}
      {data.mandate?.lastError && <p className="mt-3 text-[12px] text-cos-red-ink">Responsabilidad mensual: {data.mandate.lastError}</p>}
      {form && <form className="mt-4 grid gap-3 rounded-control border border-cos-line bg-cos-paper p-3" onSubmit={(event) => {
        event.preventDefault();
        if (form === "configure") void mutate({ action: "configure", responsibleUserId: responsible, enabled: recurring, startPeriod: selectedPeriod, maxRunsPerDay: limit });
        else { const [year, month] = selectedPeriod.split("-").map(Number); void mutate({ action: "assign", year, month, scope, instructions }); }
      }}>
        <p className="text-[13px] font-medium text-cos-ink">{form === "configure" ? "Responsabilidad mensual" : "Nueva revisión de cierre"}</p>
        <label className="text-[12px] text-cos-ink-soft">{form === "configure" ? "Primer periodo" : "Periodo"}<input aria-label="Periodo del objetivo" className={INPUT} type="month" required value={selectedPeriod} max={data.defaultPeriod} onChange={(e) => setSelectedPeriod(e.target.value)} /></label>
        {form === "assign" ? <>
          <label className="text-[12px] text-cos-ink-soft">Alcance<select className={INPUT} value={scope} onChange={(e) => setScope(e.target.value)}>{["cierre", ...ORDEN_PASOS].map((key) => <option key={key} value={key}>{SCOPE_LABELS[key]}</option>)}</select></label>
          <label className="text-[12px] text-cos-ink-soft">Instrucciones opcionales<textarea className={INPUT} value={instructions} maxLength={2000} rows={2} onChange={(e) => setInstructions(e.target.value)} /></label>
          <p className="text-[12px] text-cos-ink-soft">Tú serás responsable. ContaBot revisa evidencia, prepara propuestas y pide documentos; las decisiones contables conservan su confirmación.</p>
        </> : <>
          <label className="text-[12px] text-cos-ink-soft">Responsable<select className={INPUT} value={responsible} onChange={(e) => setResponsible(e.target.value)} required>{data.responsibleUsers.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
          <label className="text-[12px] text-cos-ink-soft">Máximo de revisiones diarias<input className={INPUT} type="number" min={1} max={12} value={limit} onChange={(e) => setLimit(Number(e.target.value))} required /></label>
          <label className="flex items-center gap-2 text-[13px] text-cos-ink"><input type="checkbox" checked={recurring} disabled={!data.available} onChange={(e) => setRecurring(e.target.checked)} /> Preparar cada cierre mensual</label>
          <p className="text-[12px] text-cos-ink-soft">Crea un objetivo por mes terminado desde el periodo elegido. Opera con los permisos actuales del responsable y el presupuesto de IA. Al desactivar o cambiar de responsable, se pausan los objetivos recurrentes; se reanudan individualmente.</p>
        </>}
        <div className="flex gap-2"><button className={BUTTON} type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button><button className={BUTTON} type="button" onClick={() => setForm(null)} disabled={busy}>Cancelar</button></div>
      </form>}
      {!visible.length && <p className="mt-4 text-[13px] text-cos-ink-soft">{hidden ? "No hay objetivos activos en esta vista." : "Asigna el cierre o un paso concreto. ContaBot conservará el trabajo, los bloqueos y la evidencia entre sesiones."}</p>}
      <div className="mt-3 grid gap-3">
        {visible.map((o) => {
          const periodKey = `${o.year}-${String(o.month).padStart(2, "0")}`;
          const canManage = data.permissions.canWrite && (data.permissions.canManage || data.userId === o.responsibleUserId);
          return <article key={o.id} className="border-t border-cos-line-soft pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-semibold text-cos-ink">{o.title} · {periodKey}</h3><span className="rounded-full bg-cos-paper px-2 py-0.5 text-[11px] text-cos-ink-soft">{OBJECTIVE_LABELS[o.state] ?? o.state}</span></div>
            <p className="mt-1 text-[13px] text-cos-ink-soft">{o.lastError ?? o.nextAction}</p>
            <p className="mt-1 text-[11px] text-cos-ink-faint">Responsable: {data.responsibleUsers.find((u) => u.id === o.responsibleUserId)?.label ?? "Miembro sin acceso actual"}{o.dueDate ? ` · Vencimiento del checklist: ${o.dueDate.slice(0, 10)}` : ""}{o.lastCheckedAt ? ` · Revisado ${new Date(o.lastCheckedAt).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}` : ""}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {o.conversationId && <button className={BUTTON} onClick={() => window.dispatchEvent(new CustomEvent("cos:ask-ai", { detail: { conversationId: o.conversationId, companyId } }))}>Ver trabajo y decisiones</button>}
              <Link className={BUTTON} href={`/cierre?y=${o.year}&m=${o.month}`}>Ver evidencia del cierre</Link>
              {canManage && !o.pausedAt && <button disabled={busy} className={BUTTON} onClick={() => void mutate({ action: "pause", id: o.id, version: o.version })}><Pause className="h-3 w-3" /> Pausar</button>}
              {canManage && data.available && (o.pausedAt || o.state === "blocked") && <button disabled={busy} className={BUTTON} onClick={() => void mutate({ action: "resume", id: o.id, version: o.version })}><Play className="h-3 w-3" /> Reanudar revisión</button>}
            </div>
            {o.runs.length > 0 && <details className="mt-2 text-[11px] text-cos-ink-faint"><summary className="cursor-pointer">Últimas revisiones ({o.runs.length})</summary><ul className="mt-1 space-y-1">{o.runs.map((run) => <li key={run.id}>{new Date(run.createdAt).toLocaleString("es-MX")} · {({ queued: "Asignada", running: "En curso", succeeded: "Revisión terminada", failed: "Detenida" } as Record<string, string>)[run.state] ?? run.state}{run.error ? ` · ${run.error}` : ""}</li>)}</ul></details>}
          </article>;
        })}
      </div>
      {(hidden > 0 || showHistory) && <button className="mt-3 flex items-center gap-1 text-[12px] text-cos-ink-soft" onClick={() => setShowHistory(!showHistory)}><ChevronDown className="h-3 w-3" />{showHistory ? "Ocultar pausados y verificados" : `Ver pausados y verificados (${hidden})`}</button>}
    </section>
  );
}
