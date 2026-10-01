"use client";

import { useEffect, useRef, useState } from "react";
import { ELECTION_CHOICES, REVIEW_DECISIONS } from "@/lib/fiscal/deduction-review-contract";
import type { DeductionReviewWorkspace, readDeductionReviewHistory } from "@/lib/fiscal/deduction-review";

type Row = DeductionReviewWorkspace["renglones"][number];
type Election = DeductionReviewWorkspace["elecciones"][number];
type Target = { kind: "review"; row: Row } | { kind: "election"; election: Election };
type History = Awaited<ReturnType<typeof readDeductionReviewHistory>>;
const inputClass = "mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-cos-ink";
const buttonClass = "rounded-control border border-cos-line px-3 py-2 text-[12px] font-medium text-cos-brand-ink disabled:opacity-50";
const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
const stateLabel = { VIGENTE: "Evidencia sin cambios", DESACTUALIZADA: "Revisar de nuevo", REGISTRADA: "Evidencia registrada", FUERA_DE_VIGENCIA: "Fuera del periodo informado", PENDIENTE: "Pendiente de confirmar" };
const electionLabel = (election: Election) => Object.entries(election.opciones).find(([code]) => code === election.registro?.choice)?.[1] ?? "Pendiente de confirmar";

export function DeductionReviewPanel(props: { companyId: string; periodo: string; refreshKey: number; onReviewInvoice: (id: string) => Promise<void> }) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(props.periodo)) return null;
  // A different company/period cannot inherit a draft, response or saved token.
  return <ScopedReview key={`${props.companyId}:${props.periodo}`} {...props} />;
}

function ScopedReview({ companyId, periodo, refreshKey, onReviewInvoice }: Parameters<typeof DeductionReviewPanel>[0]) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DeductionReviewWorkspace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const [references, setReferences] = useState("");
  const [from, setFrom] = useState(`${periodo.slice(0, 4)}-01`);
  const [to, setTo] = useState(`${periodo.slice(0, 4)}-12`);
  const [acknowledged, setAcknowledged] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const controller = useRef<AbortController | null>(null);
  const editor = useRef<HTMLFormElement | null>(null);
  const attempt = useRef<{ payload: string; requestId: string } | null>(null);
  const previousRefresh = useRef(refreshKey);
  const url = `/api/impuestos/asignaciones-regimen/deducciones/revision?${new URLSearchParams({ companyId, year: periodo.slice(0, 4), month: String(Number(periodo.slice(5))) })}`;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (target) {
      editor.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      editor.current?.querySelector("select")?.focus({ preventScroll: true });
    }
  }, [target]);
  useEffect(() => {
    if (previousRefresh.current !== refreshKey) {
      previousRefresh.current = refreshKey;
      setConflict(true);
      setNotice("Cambió la asignación de un CFDI. Recarga la evidencia antes de guardar; tu borrador sigue aquí.");
    }
  }, [refreshKey]);

  async function load(page = 1, historyOnly = false) {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    setLoading(true); setError("");
    try {
      const response = await fetch(`${url}&page=${page}${historyOnly ? "&history=1" : ""}`, { signal: active.signal, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "No se pudo cargar la revisión.");
      if (active.signal.aborted) return;
      if (historyOnly) setHistory(body);
      else { setData(body); setConflict(false); }
    } catch (e) { if (!active.signal.aborted) setError(e instanceof Error ? e.message : "No se pudo cargar la revisión."); }
    finally { if (!active.signal.aborted) setLoading(false); }
  }

  function edit(next: Target) {
    const saved = next.kind === "review" ? next.row.review : next.election.registro;
    setTarget(next); setReason(saved?.reason ?? ""); setReferences(saved?.references.join("\n") ?? "");
    setDecision(next.kind === "review" ? next.row.review?.decision ?? "DOCUMENTADA" : next.election.registro?.choice ?? "PENDIENTE");
    if (next.kind === "election") { setFrom(next.election.registro?.effectiveFrom ?? `${periodo.slice(0, 4)}-01`); setTo(next.election.registro?.effectiveTo ?? `${periodo.slice(0, 4)}-12`); }
    setAcknowledged(false); setError(""); setNotice(""); attempt.current = null;
  }

  async function save() {
    if (!data || !target || !acknowledged || conflict || saving) return;
    const payload = JSON.stringify({ kind: target.kind, evidenceHash: data.evidenceHash, reason,
      references: references.split("\n").map((ref) => ref.trim()).filter(Boolean), acknowledged,
      ...(target.kind === "review" ? { invoiceId: target.row.invoiceId, source: target.row.source, regimenCode: target.row.regimenCode,
        expectedRevision: target.row.review?.revision ?? 0, decision } : { regimenCode: target.election.regimenCode,
        expectedRevision: target.election.registro?.revision ?? 0, choice: decision, effectiveFrom: from, effectiveTo: to }) });
    if (attempt.current?.payload !== payload) attempt.current = { payload, requestId: crypto.randomUUID() };
    const active = new AbortController(); controller.current = active;
    setSaving(true); setError("");
    try {
      const response = await fetch(url, { method: "POST", signal: active.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(payload), requestId: attempt.current.requestId }) });
      const body = await response.json();
      if (active.signal.aborted) return;
      if (response.status === 409) setConflict(true);
      if (!response.ok) throw new Error(body.error ?? "No se pudo guardar la revisión.");
      setTarget(null); setHistory(null); attempt.current = null;
      setNotice(`Versión ${body.revision} guardada. No autoriza importes ni cambia cálculos, declaraciones o cierres.`);
      setSaving(false);
      await load(data.page);
    } catch (e) { if (!active.signal.aborted) setError(e instanceof Error ? e.message : "No se pudo guardar. Reintenta el mismo envío."); }
    finally { if (!active.signal.aborted) setSaving(false); }
  }

  return <section className="mt-3 rounded-card border border-cos-line bg-cos-card px-4 py-3 text-[12.5px]" aria-label="Revisión de deducciones por régimen">
    <button className="font-semibold text-cos-brand-ink" disabled={saving} aria-expanded={open} onClick={() => {
      setOpen(!open); if (!open && !data) void load();
    }}>Revisión de deducciones · {periodo} {open ? "−" : "+"}</button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-cos-ink-soft">Bases documentales y criterios del contador. Ninguna revisión autoriza un importe deducible ni modifica el cálculo automático.</p>
      {notice && <p role="status" className="text-cos-brand-ink">{notice}</p>}
      {error && <p role="alert" className="text-cos-red-ink">{error}</p>}
      {loading && <p role="status">Cargando evidencia…</p>}
      <button disabled={loading || saving} className={buttonClass} onClick={() => {
        if (target && !window.confirm("¿Descartar el borrador y cargar la evidencia actual?")) return;
        setTarget(null); void load(data?.page ?? 1);
      }}>Recargar evidencia</button>
      {data && <>
        <p>{data.resumen.revisionesVigentes} revisiones documentadas vigentes de {data.resumen.asignaciones} asignaciones · {data.resumen.revisionesDesactualizadas} desactualizadas.</p>
        {!data.puedeDocumentar && <p className="text-cos-amber-ink">No se pueden documentar nuevos criterios: revisa los pendientes documentales, el límite de lectura o la cobertura 2026.</p>}
        {data.resumen.pendientesDocumentales > 0 && <details><summary>{data.resumen.pendientesDocumentales} pendientes documentales</summary>
          <ul className="mt-2 space-y-1">{data.documental.pendientes.map((item) => <li key={`${item.id}:${item.code}`}>{item.code} · {item.id}</li>)}</ul></details>}
        {data.resumen.revisionesSinRenglon > 0 && <p className="text-cos-amber-ink">{data.resumen.revisionesSinRenglon} revisiones ya no tienen un renglón documental válido. Se conservan en el historial; no se consideran vigentes.</p>}
        <div className="space-y-2" aria-label="Opciones informadas del contribuyente">
          {data.elecciones.filter((e) => e.aplicable || e.registro).map((e) => <div key={e.regimenCode} className="rounded-control border border-cos-line p-3">
            <p className="font-semibold">Opción informada · régimen {e.regimenCode} · ejercicio {periodo.slice(0, 4)}</p>
            <p>{e.registro ? `${electionLabel(e)} · ${e.registro.effectiveFrom} a ${e.registro.effectiveTo} · ${stateLabel[e.registro.estado]} · v${e.registro.revision}` : "Sin evidencia registrada"}</p>
            <p className="mt-1 text-cos-ink-faint">No ejerce ni cambia una opción ante SAT. Confirma vigencia y requisitos en el expediente; las opciones de plataformas pueden tener continuidad entre ejercicios.</p>
            {data.puedeEditar && e.aplicable && periodo.startsWith("2026-") && <button className={`${buttonClass} mt-2`} disabled={!!target || saving || conflict || loading} onClick={() => edit({ kind: "election", election: e })}>Registrar evidencia de la opción</button>}
          </div>)}
        </div>
        <div className="space-y-2" aria-label="Asignaciones documentales para revisión">
          {data.renglones.map((row) => <div key={`${row.invoiceId}:${row.source}:${row.regimenCode}`} className="rounded-control border border-cos-line p-3">
            <p className="break-all font-semibold">{row.uuid} · régimen {row.regimenCode}</p>
            <p>{row.source === "PUE_DOCUMENTADO" ? "PUE por emisión (no acredita pago)" : "REP por FechaPago"} · Base documental {money(row.baseDocumentalCentavos)}</p>
            <p>{row.review ? `${REVIEW_DECISIONS[row.review.decision as keyof typeof REVIEW_DECISIONS]} · ${stateLabel[row.review.estado]} · v${row.review.revision}` : "Sin revisión documentada"}</p>
            {row.review && <p className="text-cos-ink-faint">{row.review.reviewedByEmail ?? row.review.reviewedById} · {new Date(row.review.reviewedAt).toLocaleString("es-MX")}</p>}
            <ul className="my-2 list-disc space-y-1 pl-4 text-cos-ink-soft">{row.motivos.map((code) => <li key={code}>{data.criterios[code]}</li>)}</ul>
            <button disabled={saving} className={buttonClass} onClick={() => void onReviewInvoice(row.invoiceId)}>Abrir CFDI</button>
            {data.puedeEditar && data.puedeDocumentar && <button disabled={!!target || saving || conflict || loading} className={`${buttonClass} ml-2`} onClick={() => edit({ kind: "review", row })}>Documentar criterio</button>}
          </div>)}
          {!data.renglones.length && <p>Sin asignaciones documentales disponibles en esta página.</p>}
        </div>
        <div className="flex items-center gap-2"><button className={buttonClass} disabled={data.page <= 1 || loading || saving || !!target} onClick={() => void load(data.page - 1)}>Anterior</button>
          <span>Página {data.page} de {data.pages}</span><button className={buttonClass} disabled={data.page >= data.pages || loading || saving || !!target} onClick={() => void load(data.page + 1)}>Siguiente</button></div>
      </>}
      {target && <form ref={editor} className="space-y-3 rounded-control border border-cos-brand p-3" aria-label="Guardar revisión fiscal" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="font-semibold">{target.kind === "review" ? `Criterio para ${target.row.uuid} · ${target.row.regimenCode}` : `Opción informada · ${target.election.regimenCode}`}</p>
        <label className="block">{target.kind === "review" ? "Criterio" : "Opción informada"}<select aria-label={target.kind === "review" ? "Criterio" : "Opción informada"} className={inputClass} disabled={saving} value={decision} onChange={(e) => setDecision(e.target.value)}>
          {Object.entries(target.kind === "review" ? REVIEW_DECISIONS : ELECTION_CHOICES[target.election.regimenCode]).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
        {target.kind === "election" && <div className="flex flex-wrap gap-3"><label>Vigencia informada desde<input aria-label="Vigencia informada desde" className={inputClass} type="month" required disabled={saving} value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>Hasta<input aria-label="Vigencia informada hasta" className={inputClass} type="month" required disabled={saving} value={to} onChange={(e) => setTo(e.target.value)} /></label></div>}
        <label className="block">Motivo y alcance (20 a 2000 caracteres)<textarea className={inputClass} minLength={20} maxLength={2000} required disabled={saving} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="block">Referencias al expediente (una por línea, máximo 8)<textarea className={inputClass} disabled={saving} value={references} onChange={(e) => setReferences(e.target.value)} placeholder="Acuse, papel de trabajo, estado de cuenta: folio, fecha y ubicación" /></label>
        <p className="text-cos-ink-faint">Se guardan referencias, no archivos. ContabilidadOS no descarga ni verifica fuentes externas. No incluyas contraseñas, e.firma ni enlaces con credenciales.</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} disabled={saving} onChange={(e) => setAcknowledged(e.target.checked)} />Revisé los criterios y referencias. Este registro no acredita deducibilidad ni sustituye la validación fiscal, y no cambia declaraciones o cierres.</label>
        {conflict && <p role="alert" className="text-cos-amber-ink">La evidencia cambió. Tu borrador se conserva; recarga y revisa antes de reenviar.</p>}
        <button className={buttonClass} disabled={saving || loading || !acknowledged || conflict} type="submit">{saving ? "Guardando…" : "Guardar criterio sin afectar cálculos"}</button>
        <button className={`${buttonClass} ml-2`} type="button" disabled={saving} onClick={() => setTarget(null)}>Cancelar borrador</button>
      </form>}
      <button className={buttonClass} disabled={loading || saving} onClick={() => void load(1, true)}>Ver historial de revisiones y opciones</button>
      {history && <div aria-label="Historial fiscal" className="space-y-2">
        <p>Historial inmutable · página {history.page}. Versiones anteriores no son aprobaciones vigentes.</p>
        {[...history.revisiones.map((r) => ({ ...r, label: `${r.invoiceId} · ${r.regimenCode} · ${r.decision}` })), ...history.elecciones.map((e) => ({ ...e, label: `${e.regimenCode} · ${e.choice} · ${e.effectiveFrom} a ${e.effectiveTo}` }))].map((item, i) => <div key={`${item.label}:${item.revision}:${i}`} className="rounded-control border border-cos-line p-2">
          <p className="break-all">{item.label} · v{item.revision} · {item.reviewedByEmail ?? item.reviewedById}</p><p>{item.reason}</p>
          <ul>{item.references.map((ref) => <li className="break-all" key={ref}>{ref}</li>)}</ul>
        </div>)}
        <button className={buttonClass} disabled={history.page <= 1 || loading || saving} onClick={() => void load(history.page - 1, true)}>Historial anterior</button>
        <button className={`${buttonClass} ml-2`} disabled={(history.revisiones.length < 20 && history.elecciones.length < 20) || loading || saving} onClick={() => void load(history.page + 1, true)}>Más historial</button>
      </div>}
    </div>}
  </section>;
}
