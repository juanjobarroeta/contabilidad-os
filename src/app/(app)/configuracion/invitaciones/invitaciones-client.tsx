"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Gift, Copy, Check, Trash2, Plus, Link2 } from "lucide-react";

interface Invite {
  id: string;
  despachoName: string;
  ownerNombre: string | null;
  tierEmpresas: string;
  sinCargo: boolean;
  trialDays: number;
  maxEmpresas: number | null;
  status: string;
  expiresAt: string;
  acceptedByEmail: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

const TIER_LABEL: Record<string, string> = {
  ASISTENTE: "Asistente (sin Syntage)",
  AUTOMATIZADO: "Automatizado (Syntage)",
  PRO: "Pro (Syntage + banco)",
  DESPACHO: "Despacho",
};

const inputCls =
  "w-full rounded-lg border border-cos-line bg-cos-card px-3 py-2 text-sm text-cos-ink focus:border-cos-brand focus:outline-none focus:ring-2 focus:ring-cos-brand/20";

export function InvitacionesClient() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [despachoName, setDespachoName] = useState("");
  const [ownerNombre, setOwnerNombre] = useState("");
  const [tier, setTier] = useState("AUTOMATIZADO");
  const [sinCargo, setSinCargo] = useState(true);
  const [maxEmpresas, setMaxEmpresas] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [nuevo, setNuevo] = useState<{ link: string; codigo: string; despachoName: string } | null>(null);
  const [copied, setCopied] = useState<"link" | "codigo" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/onboarding-invites");
      setInvites(res.ok ? await res.json() : []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");
    setNuevo(null);
    try {
      const res = await fetch("/api/onboarding-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          despachoName,
          ownerNombre: ownerNombre || undefined,
          tierEmpresas: tier,
          sinCargo,
          maxEmpresas: maxEmpresas.trim() ? Number(maxEmpresas) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "No se pudo crear"); return; }
      setNuevo({ link: data.link, codigo: data.codigo, despachoName: data.despachoName });
      setDespachoName(""); setOwnerNombre("");
      load();
    } finally {
      setCreating(false);
    }
  }

  async function copiar(texto: string, cual: "link" | "codigo") {
    await navigator.clipboard.writeText(texto);
    setCopied(cual);
    setTimeout(() => setCopied(null), 1800);
  }

  async function revocar(id: string) {
    if (!confirm("¿Revocar esta invitación? El enlace dejará de funcionar.")) return;
    const res = await fetch(`/api/onboarding-invites/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6">
      {/* crear */}
      <form onSubmit={crear} className="rounded-card border border-cos-line bg-cos-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold text-cos-ink">Nueva invitación</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Nombre del despacho *</span>
            <input required value={despachoName} onChange={(e) => setDespachoName(e.target.value)} className={inputCls} placeholder="Grupo Automotriz del Norte" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Nombre del dueño (opcional)</span>
            <input value={ownerNombre} onChange={(e) => setOwnerNombre(e.target.value)} className={inputCls} placeholder="Prefill del registro" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Plan de sus empresas</span>
            <select value={tier} onChange={(e) => setTier(e.target.value)} className={inputCls}>
              {Object.entries(TIER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Límite de empresas (vacío = sin límite)</span>
            <input type="number" min={1} max={100} value={maxEmpresas} onChange={(e) => setMaxEmpresas(e.target.value)}
              className={inputCls} placeholder="Ej. 9" />
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input type="checkbox" checked={sinCargo} onChange={(e) => setSinCargo(e.target.checked)} className="h-4 w-4 accent-cos-brand" />
            <span className="text-sm text-cos-ink">Cortesía — sin cargo (acceso activo sin prueba)</span>
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-cos-red-ink">{error}</p>}
        <button type="submit" disabled={creating || !despachoName.trim()}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Crear invitación
        </button>
      </form>

      {/* enlace recién creado (el token sólo se muestra aquí) */}
      {nuevo && (
        <div className="rounded-card border border-cos-jade-ink/25 bg-cos-jade-tint p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-cos-jade-ink">
            <Gift className="h-4 w-4" /> Invitación lista para {nuevo.despachoName}
          </p>
          <p className="mt-1 text-xs text-cos-jade-ink/80">
            Compártela por correo o WhatsApp. El enlace y el código sólo se muestran una vez —cópialos ahora.
          </p>
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <input readOnly value={nuevo.link} className="flex-1 rounded-lg border border-cos-jade-ink/20 bg-cos-card px-3 py-2 font-mono text-xs text-cos-ink" />
              <button onClick={() => copiar(nuevo.link, "link")} className="inline-flex items-center gap-1 rounded-lg border border-cos-jade-ink/30 px-3 py-2 text-xs font-medium text-cos-jade-ink hover:bg-cos-card">
                {copied === "link" ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />} Enlace
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input readOnly value={nuevo.codigo} className="flex-1 rounded-lg border border-cos-jade-ink/20 bg-cos-card px-3 py-2 font-mono text-xs text-cos-ink" />
              <button onClick={() => copiar(nuevo.codigo, "codigo")} className="inline-flex items-center gap-1 rounded-lg border border-cos-jade-ink/30 px-3 py-2 text-xs font-medium text-cos-jade-ink hover:bg-cos-card">
                {copied === "codigo" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Código
              </button>
            </div>
          </div>
        </div>
      )}

      {/* lista */}
      <div className="rounded-card border border-cos-line bg-cos-card shadow-card">
        <div className="border-b border-cos-line px-5 py-3 text-sm font-semibold text-cos-ink">Invitaciones</div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
        ) : invites.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-cos-ink-faint">Aún no hay invitaciones.</div>
        ) : (
          invites.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-5 py-3 last:border-0">
              <div className="min-w-0">
                <p className="text-sm font-medium text-cos-ink">{i.despachoName}</p>
                <p className="text-xs text-cos-ink-faint">
                  {TIER_LABEL[i.tierEmpresas] ?? i.tierEmpresas} · {i.sinCargo ? "cortesía" : `prueba ${i.trialDays}d`}
                  {i.maxEmpresas != null ? ` · hasta ${i.maxEmpresas} empresa${i.maxEmpresas === 1 ? "" : "s"}` : " · empresas sin límite"} · vence {fmt(i.expiresAt)}
                  {i.acceptedByEmail ? ` · aceptada por ${i.acceptedByEmail}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  i.status === "PENDING" ? "bg-cos-amber-tint text-cos-amber-ink"
                  : i.status === "ACCEPTED" ? "bg-cos-jade-tint text-cos-jade-ink"
                  : "bg-cos-slate-tint text-cos-ink-soft"
                }`}>
                  {i.status === "PENDING" ? "Pendiente" : i.status === "ACCEPTED" ? "Aceptada" : "Revocada"}
                </span>
                {i.status === "PENDING" && (
                  <button onClick={() => revocar(i.id)} className="rounded-md border border-cos-red-ink/20 p-1.5 text-cos-red-ink hover:bg-cos-red-tint" title="Revocar">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
