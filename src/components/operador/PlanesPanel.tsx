"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Panel de operador para TIERS (planes). Sustituye a scripts/set-tier.mjs
// para el caso manual: elegir un despacho, ver sus empresas con su tier y
// cambiarlas todas (o una) a otro tier. Cada cambio queda en bitácora.
// Sólo operador de plataforma (el endpoint devuelve 403 al resto).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

type Tier = "ASISTENTE" | "AUTOMATIZADO" | "PRO" | "DESPACHO";
interface Empresa { id: string; rfc: string; razonSocial: string; tier: Tier }
interface Despacho { id: string; nombre: string; defaultTier: Tier | null; empresas: Empresa[] }
interface Data { tiers: { valor: Tier; label: string }[]; despachos: Despacho[]; sinDespacho: Empresa[] }
interface Resultado {
  tier: Tier;
  cambiadas: { rfc: string; razonSocial: string; antes: Tier; despues: Tier }[];
  sinCambio: { rfc: string; razonSocial: string; tier: Tier }[];
}

const TIER_CHIP: Record<Tier, string> = {
  ASISTENTE: "bg-cos-slate-tint text-cos-ink-soft",
  AUTOMATIZADO: "bg-cos-brand-tint text-cos-brand-ink",
  PRO: "bg-cos-jade-tint text-cos-jade-ink",
  DESPACHO: "bg-cos-amber-tint text-cos-amber-ink",
};

export function PlanesPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [despachoId, setDespachoId] = useState("");
  const [tier, setTier] = useState<Tier>("PRO");
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [denied, setDenied] = useState(false);

  const cargar = useCallback(async () => {
    const res = await fetch("/api/operador/tiers");
    if (res.status === 403) { setDenied(true); return; }
    const j = (await res.json().catch(() => null)) as Data | null;
    if (res.ok && j) setData(j);
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  if (denied || !data) return null;

  const despacho = data.despachos.find((d) => d.id === despachoId) ?? null;
  const empresas = despachoId === "__sin__" ? data.sinDespacho : (despacho?.empresas ?? []);
  const objetivo = seleccion.size > 0 ? empresas.filter((e) => seleccion.has(e.id)) : empresas;
  const aCambiar = objetivo.filter((e) => e.tier !== tier);

  async function aplicar() {
    if (aCambiar.length === 0) return;
    const lista = aCambiar.map((e) => `${e.razonSocial} (${e.tier} → ${tier})`).join("\n");
    if (!window.confirm(`Cambiar ${aCambiar.length} empresa(s) a ${tier}:\n\n${lista}\n\n${tier === "ASISTENTE" ? "" : "Con AUTOMATIZADO o superior se enciende Syntage (cuesta por extracción)."}`)) return;
    setBusy(true); setError(""); setResultado(null);
    try {
      const body =
        seleccion.size > 0 || despachoId === "__sin__"
          ? { tier, companyIds: objetivo.map((e) => e.id) }
          : { tier, despachoId };
      const res = await fetch("/api/operador/tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => null)) as (Resultado & { error?: string }) | null;
      if (!res.ok || !j) { setError(j?.error ?? `HTTP ${res.status}`); return; }
      setResultado(j);
      setSeleccion(new Set());
      await cargar();
    } catch {
      setError("No se pudo aplicar el cambio");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
        <ShieldCheck className="h-4 w-4 text-cos-brand" /> Planes por despacho
      </p>
      <p className="mt-1 text-[12.5px] text-cos-ink-soft">
        Cambia el tier de todas las empresas de un despacho, o sólo de las que marques. AUTOMATIZADO+ enciende Syntage; PRO/DESPACHO además banco, WhatsApp y el cierre guiado.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_auto]">
        <label className="text-[12.5px] font-medium text-cos-ink-soft">
          Despacho
          <select
            value={despachoId}
            onChange={(e) => { setDespachoId(e.target.value); setSeleccion(new Set()); setResultado(null); }}
            className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[14px]"
          >
            <option value="">Selecciona despacho…</option>
            {data.despachos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre} · {d.empresas.length} empresa{d.empresas.length === 1 ? "" : "s"}
                {d.defaultTier ? ` · alta en ${d.defaultTier}` : ""}
              </option>
            ))}
            {data.sinDespacho.length > 0 && <option value="__sin__">Sin despacho · {data.sinDespacho.length}</option>}
          </select>
        </label>
        <label className="text-[12.5px] font-medium text-cos-ink-soft">
          Tier destino
          <select value={tier} onChange={(e) => setTier(e.target.value as Tier)} className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[14px]">
            {data.tiers.map((t) => <option key={t.valor} value={t.valor}>{t.label}</option>)}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void aplicar()}
            disabled={busy || aCambiar.length === 0}
            className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {seleccion.size > 0 ? `Cambiar ${aCambiar.length} marcada${aCambiar.length === 1 ? "" : "s"}` : `Cambiar ${aCambiar.length} a ${tier}`}
          </button>
        </div>
      </div>

      {empresas.length > 0 && (
        <ul className="mt-3 max-h-72 divide-y divide-cos-line-soft overflow-y-auto rounded-[10px] border border-cos-line">
          {empresas.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={seleccion.has(e.id)}
                onChange={(ev) => {
                  const s = new Set(seleccion);
                  if (ev.target.checked) s.add(e.id); else s.delete(e.id);
                  setSeleccion(s);
                }}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-cos-ink">{e.razonSocial}</span>
              <span className="font-mono text-[11px] text-cos-ink-faint">{e.rfc}</span>
              <span className={cn("rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold", TIER_CHIP[e.tier])}>{e.tier}</span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-cos-red-ink">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      )}
      {resultado && (
        <div className="mt-3 rounded-[10px] border border-cos-jade/40 bg-cos-jade-tint px-3 py-2.5 text-[12.5px] text-cos-jade-ink">
          <p className="font-medium">
            {resultado.cambiadas.length} cambiada{resultado.cambiadas.length === 1 ? "" : "s"} a {resultado.tier}
            {resultado.sinCambio.length > 0 && ` · ${resultado.sinCambio.length} ya estaba${resultado.sinCambio.length === 1 ? "" : "n"}`}
          </p>
          {resultado.cambiadas.map((c) => (
            <p key={c.rfc} className="mt-0.5">{c.razonSocial}: {c.antes} → {c.despues}</p>
          ))}
        </div>
      )}
    </Card>
  );
}
