"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Landmark, Upload, Sparkles, Loader2, Link2, Search, CheckCircle2,
  AlertTriangle, SlidersHorizontal, ChevronRight,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Chip } from "@/components/ui";

// ── Types (mirror /api/bancos) ────────────────────────────────────────────────
interface BankAccount {
  id: string; banco: string; nombre: string; numeroCuenta: string; clabe?: string;
  titular?: string | null; moneda: string;
  stats: { total: number; unmatched: number; matched: number; ignored: number };
  lastTransaction: { fecha: string; saldo?: number } | null;
}
interface BankTx {
  id: string; fecha: string; descripcion: string; monto: number; referencia?: string; saldo?: number;
  tipo: "CREDITO" | "DEBITO"; status: "UNMATCHED" | "MATCHED" | "IGNORED";
  invoiceId?: string | null;
  invoice?: { id: string; uuid?: string; total: number; customer?: { razonSocial: string } } | null;
}
interface Candidate {
  id: string; uuid?: string; fecha: string; total: number; cliente: string; rfc: string;
  score: number; confidence: "alta" | "media" | "baja"; folio?: string;
}
type Filter = "all" | "UNMATCHED" | "MATCHED";

const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";
const CONF: Record<Candidate["confidence"], "jade" | "amber" | "slate"> = { alta: "jade", media: "amber", baja: "slate" };
// Lee un archivo binario (Excel) como base64 sin el prefijo data: — robusto para
// archivos grandes (no usa String.fromCharCode sobre todo el buffer).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const fmtFecha = (iso: string) => {
  const M = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export default function BancosPage() {
  const { activeCompany } = useCompany();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"" | "auto" | "upload">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2800); };

  const loadAccounts = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/bancos?companyId=${activeCompany.id}`);
    const data = await res.json();
    const list: BankAccount[] = Array.isArray(data) ? data : [];
    setAccounts(list);
    setSelectedId((prev) => prev && list.some((a) => a.id === prev) ? prev : list[0]?.id ?? null);
  }, [activeCompany]);

  const loadTxs = useCallback(async () => {
    if (!selectedId) { setTxs([]); return; }
    setLoading(true); setExpandedId(null);
    try {
      const res = await fetch(`/api/bancos/${selectedId}?status=${filter}&page=1&pageSize=50`);
      const data = await res.json();
      setTxs(data.transactions ?? []);
      setCounts(data.statusCounts ?? {});
    } finally { setLoading(false); }
  }, [selectedId, filter]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadTxs(); }, [loadTxs]);

  const account = accounts.find((a) => a.id === selectedId) ?? null;

  async function autoReconcile() {
    if (!selectedId) return;
    setBusy("auto");
    try {
      const res = await fetch(`/api/bancos/${selectedId}/match`, { method: "POST" });
      const data = await res.json();
      const n = data.autoMatched ?? 0;
      showToast(n > 0 ? `${n} movimiento${n === 1 ? "" : "s"} conciliado${n === 1 ? "" : "s"} automáticamente` : "Sin coincidencias automáticas de alta confianza");
      await Promise.all([loadTxs(), loadAccounts()]);
    } finally { setBusy(""); }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    setBusy("upload");
    try {
      // Excel (.xlsx/.xls/.xlsm) es binario: se envía en base64. CSV/TXT/OFX como texto.
      const esExcel = /\.(xlsx|xls|xlsm)$/i.test(file.name);
      const fileContent = esExcel ? await fileToBase64(file) : await file.text();
      const res = await fetch(`/api/bancos/${selectedId}/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileContent, filename: file.name, encoding: esExcel ? "base64" : "text" }),
      });
      const data = await res.json();
      showToast(data.message ?? (data.ok ? `Importados ${data.imported}` : "No se pudo importar"));
      await Promise.all([loadTxs(), loadAccounts()]);
    } finally { setBusy(""); e.target.value = ""; }
  }

  async function expand(tx: BankTx) {
    if (expandedId === tx.id) { setExpandedId(null); return; }
    setExpandedId(tx.id); setCandidates([]); setCandLoading(true);
    try {
      const res = await fetch(`/api/bancos/${selectedId}/match?txId=${tx.id}`);
      const data = await res.json();
      setCandidates(data.candidates ?? []);
    } finally { setCandLoading(false); }
  }

  async function conciliar(txId: string, invoiceId: string) {
    const res = await fetch(`/api/bancos/transactions/${txId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "match", invoiceId }),
    });
    if (res.ok) { showToast("Movimiento conciliado"); setExpandedId(null); await Promise.all([loadTxs(), loadAccounts()]); }
    else showToast("No se pudo conciliar");
  }

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Bancos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">Conectamos los movimientos de tu banco con tus facturas para que todo cuadre.</p>
        </div>
        <Link href="/bancos/detalle" className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-4 py-2 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper">
          <SlidersHorizontal className="h-4 w-4" /> Detalle
        </Link>
      </div>

      {accounts.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line p-10 text-center shadow-card">
          <Landmark className="mx-auto mb-3 h-10 w-10 text-cos-ink-faint opacity-40" />
          <p className="text-sm font-medium text-cos-ink">Sin cuentas bancarias</p>
          <Link href="/bancos/detalle" className="mt-2 inline-block text-[13px] font-semibold text-cos-brand-ink hover:underline">Agregar una cuenta →</Link>
        </Card>
      ) : (
        <>
          {/* account selector */}
          {accounts.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {accounts.map((a) => (
                <button key={a.id} onClick={() => setSelectedId(a.id)}
                  className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (a.id === selectedId ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-white text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                  {a.banco} <span className="font-mono text-[12px] opacity-80">••{a.numeroCuenta.slice(-4)}</span>
                </button>
              ))}
            </div>
          )}

          {/* account card */}
          {account && (
            <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
              <div className="flex items-center gap-3.5">
                <div className="grid h-[42px] w-[42px] flex-none place-items-center rounded-[12px] bg-cos-brand-tint text-cos-brand-ink"><Landmark className="h-[22px] w-[22px]" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold text-cos-ink">{account.banco}</p>
                  <p className="truncate text-[13px] text-cos-ink-soft">{account.titular ?? account.nombre} · <span className="font-mono">••••{account.numeroCuenta.slice(-4)}</span></p>
                </div>
                {account.stats.unmatched > 0
                  ? <Chip status="sin_conciliar" label={`${account.stats.unmatched} por conciliar`} />
                  : <Chip status="conciliado" label="Todo cuadrado" />}
              </div>
              <div className="my-[18px] flex flex-col gap-1.5 border-y border-cos-line-soft py-4">
                <span className={LBL}>Saldo en banco</span>
                {account.lastTransaction?.saldo != null
                  ? <Money value={account.lastTransaction.saldo} size={30} weight={700} />
                  : <span className="font-mono text-[20px] text-cos-ink-faint">—</span>}
              </div>
              <div className="flex flex-wrap gap-2.5">
                <label className={"flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-control border border-cos-line bg-white px-4 py-2.5 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper " + (busy ? "pointer-events-none opacity-50" : "")}>
                  {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Cargar estado de cuenta
                  <input type="file" accept=".csv,.txt,.ofx,.xlsx,.xls,.xlsm" className="hidden" onChange={onUpload} disabled={!!busy} />
                </label>
                <button onClick={autoReconcile} disabled={!!busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
                  {busy === "auto" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Conciliar automáticamente
                </button>
              </div>
            </Card>
          )}

          {/* filter chips */}
          <div className="mt-4 flex flex-wrap gap-2">
            {([["all","Todos"],["UNMATCHED","Sin conciliar"],["MATCHED","Conciliados"]] as [Filter,string][]).map(([k, t]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (filter === k ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-white text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                {t} <span className="font-mono text-[12px] opacity-80">{k === "all" ? (counts.total ?? 0) : (counts[k] ?? 0)}</span>
              </button>
            ))}
          </div>

          {/* movements */}
          <div className="mt-3 flex flex-col gap-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
            ) : txs.length === 0 ? (
              <Card className="rounded-card border-cos-line p-10 text-center text-cos-ink-faint shadow-card">No hay movimientos con ese filtro.</Card>
            ) : txs.map((m) => {
              const matched = m.status === "MATCHED";
              return (
                <Card key={m.id} className={"rounded-card p-4 shadow-card " + (matched ? "border-[oklch(0.85_0.04_168)] bg-[oklch(0.99_0.006_168)]" : "border-cos-line")}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[12.5px] text-cos-ink-faint">{fmtFecha(m.fecha)}</span>
                    <Money value={m.monto} sign size={17} weight={700} />
                  </div>
                  <p className="mt-2 text-[14.5px] font-medium leading-snug text-cos-ink">{m.descripcion}</p>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12px] text-cos-ink-faint">
                      {m.referencia && <>Ref <span className="font-mono">{m.referencia}</span></>}
                      {m.saldo != null && <> · Saldo <span className="font-mono">${m.saldo.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></>}
                    </span>
                    <Chip status={matched ? "conciliado" : "sin_conciliar"} icon={matched ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />} />
                  </div>

                  {matched && m.invoice && (
                    <div className="mt-3 flex items-center gap-1.5 border-t border-dashed border-[oklch(0.85_0.04_168)] pt-3 text-[13px] text-cos-jade-ink">
                      <Link2 className="h-[15px] w-[15px]" /> Conciliado con <b>{m.invoice.customer?.razonSocial ?? "factura"}</b>
                    </div>
                  )}

                  {!matched && (
                    <div className="mt-3 border-t border-dashed border-cos-line pt-3">
                      <button onClick={() => expand(m)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-cos-brand-ink hover:underline">
                        <Search className="h-[15px] w-[15px]" /> {expandedId === m.id ? "Ocultar" : "Buscar coincidencia"}
                      </button>
                      {expandedId === m.id && (
                        <div className="mt-2.5 flex flex-col gap-2">
                          {candLoading ? (
                            <span className="inline-flex items-center gap-2 text-[13px] text-cos-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando facturas…</span>
                          ) : candidates.length === 0 ? (
                            <span className="text-[13px] text-cos-ink-faint">Sin coincidencias automáticas. Vincula manualmente en <Link href="/bancos/detalle" className="font-semibold text-cos-brand-ink hover:underline">Detalle</Link>.</span>
                          ) : candidates.map((c) => (
                            <div key={c.id} className="flex items-center justify-between gap-3 rounded-control bg-cos-paper px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="truncate text-[13.5px] font-medium text-cos-ink">{c.cliente}</p>
                                <p className="text-[12px] text-cos-ink-faint"><span className="font-mono">{c.rfc}</span> · {fmtFecha(c.fecha)} · <Money value={c.total} size={12} muted /></p>
                              </div>
                              <div className="flex flex-none items-center gap-2">
                                <Chip tone={CONF[c.confidence]} label={c.confidence} />
                                <button onClick={() => conciliar(m.id, c.id)} className="rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep">Conciliar</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {(counts.total ?? 0) > txs.length && (
            <Link href="/bancos/detalle" className="mt-3 flex items-center justify-center gap-1.5 rounded-card border border-dashed border-cos-line bg-white px-5 py-3 text-[13.5px] font-medium text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
              Ver todos los movimientos, conciliación en lote y categorías <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </>
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-xl bg-cos-ink px-5 py-3 text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}
