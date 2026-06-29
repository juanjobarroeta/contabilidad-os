"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Landmark, Upload, Sparkles, Loader2, Link2, Search, CheckCircle2,
  AlertTriangle, ChevronDown, Plus, CheckSquare, X, Building2, Users,
  Banknote, Ban, ArrowLeftRight, SlidersHorizontal, Pencil, Trash2,
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
  notes?: string | null;
  invoiceId?: string | null;
  invoice?: { id: string; uuid?: string; total: number; customer?: { razonSocial: string } } | null;
}
interface Candidate {
  id: string; uuid?: string; fecha: string; total: number; cliente: string; rfc: string;
  score: number; confidence: "alta" | "media" | "baja"; folio?: string;
}
interface Counts {
  UNMATCHED?: number; MATCHED?: number; IGNORED?: number; total?: number;
  PENDING?: number; TAX_PAYMENT?: number; PAYROLL_NO_CFDI?: number;
  LOAN_RECEIVED?: number; LOAN_GIVEN?: number; CAPITAL_CONTRIBUTION?: number;
  NON_DEDUCTIBLE?: number; INTERNAL_TRANSFER?: number;
}

// Filtro = estado base o sub-categoría por tag (la API entiende ambos en ?status=).
type Filter =
  | "all" | "UNMATCHED" | "MATCHED" | "IGNORED"
  | "PENDING" | "TAX_PAYMENT" | "PAYROLL_NO_CFDI" | "LOAN_RECEIVED"
  | "LOAN_GIVEN" | "CAPITAL_CONTRIBUTION" | "NON_DEDUCTIBLE" | "INTERNAL_TRANSFER";

// Categorías "sin factura" → tag de notes que persiste (PATCH ignore). null = ignorar simple.
const CATEGORIAS: { tag: string | null; label: string; icon: typeof Banknote }[] = [
  { tag: "TAX_PAYMENT",          label: "Pago de impuestos",        icon: Building2 },
  { tag: "PAYROLL_NO_CFDI",      label: "Nómina sin CFDI",          icon: Users },
  { tag: "LOAN_RECEIVED",        label: "Préstamo recibido",        icon: Banknote },
  { tag: "LOAN_GIVEN",           label: "Préstamo otorgado",        icon: Banknote },
  { tag: "CAPITAL_CONTRIBUTION", label: "Aportación de capital",    icon: Building2 },
  { tag: "NON_DEDUCTIBLE",       label: "No deducible",             icon: Ban },
  { tag: "INTERNAL_TRANSFER",    label: "Transferencia entre cuentas", icon: ArrowLeftRight },
  { tag: null,                   label: "Ignorar",                  icon: X },
];
// tag → etiqueta corta para el chip de estado en un movimiento ya categorizado.
const TAG_LABEL: Record<string, string> = {
  TAX_PAYMENT: "Impuestos", PENDING_MONTHLY_CFDI: "Pendiente CFDI",
  PAYROLL_NO_CFDI: "Nómina", LOAN_RECEIVED: "Préstamo", LOAN_GIVEN: "Préstamo otorgado",
  CAPITAL_CONTRIBUTION: "Capital", NON_DEDUCTIBLE: "No deducible", INTERNAL_TRANSFER: "Transferencia",
};
// Chips de "Más filtros": tag de filtro → etiqueta + clave de conteo.
const TIPO_CHIPS: { f: Filter; t: string; k: keyof Counts }[] = [
  { f: "PENDING", t: "Pendiente CFDI", k: "PENDING" },
  { f: "TAX_PAYMENT", t: "Impuestos", k: "TAX_PAYMENT" },
  { f: "PAYROLL_NO_CFDI", t: "Nómina sin CFDI", k: "PAYROLL_NO_CFDI" },
  { f: "LOAN_RECEIVED", t: "Préstamos", k: "LOAN_RECEIVED" },
  { f: "LOAN_GIVEN", t: "Préstamos otorgados", k: "LOAN_GIVEN" },
  { f: "CAPITAL_CONTRIBUTION", t: "Capital", k: "CAPITAL_CONTRIBUTION" },
  { f: "INTERNAL_TRANSFER", t: "Transferencias", k: "INTERNAL_TRANSFER" },
  { f: "NON_DEDUCTIBLE", t: "No deducible", k: "NON_DEDUCTIBLE" },
  { f: "IGNORED", t: "Ignorados", k: "IGNORED" },
];

const BANKS = ["BBVA","Banamex","Santander","Banorte","HSBC","Scotiabank","Afirme","Inbursa","BanBajío","Otro"];
const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";
const CONF: Record<Candidate["confidence"], "jade" | "amber" | "slate"> = { alta: "jade", media: "amber", baja: "slate" };
const fmtFecha = (iso: string) => {
  const M = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function BancosPage() {
  const { activeCompany } = useCompany();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [showMore, setShowMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"" | "auto" | "upload">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  // Búsqueda manual de factura para el movimiento expandido (inline, antes era /detalle).
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTipo, setManualTipo] = useState<"INGRESO" | "EGRESO" | "NOMINA">("EGRESO");
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<FacturaSearch[]>([]);
  const [manualLoading, setManualLoading] = useState(false);
  const [toast, setToast] = useState("");
  // Modo selección + lote
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkMatchOpen, setBulkMatchOpen] = useState(false);
  // Modal de cuenta: null=cerrado · {account:null}=agregar · {account:X}=editar
  const [accountModal, setAccountModal] = useState<{ account: BankAccount | null } | null>(null);

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
      const res = await fetch(`/api/bancos/${selectedId}?status=${filter}&page=1&pageSize=80`);
      const data = await res.json();
      setTxs(data.transactions ?? []);
      setCounts(data.statusCounts ?? {});
    } finally { setLoading(false); }
  }, [selectedId, filter]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadTxs(); }, [loadTxs]);
  // Salir del modo selección al cambiar de cuenta/filtro.
  useEffect(() => { setPicked(new Set()); }, [selectedId, filter]);

  // Búsqueda manual de facturas (debounced) para el movimiento expandido.
  useEffect(() => {
    if (!expandedId || !manualOpen || !activeCompany) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setManualLoading(true);
      try {
        const params = new URLSearchParams({ companyId: activeCompany.id, tipo: manualTipo, take: "20", unmatchedOnly: "true" });
        if (manualQuery.trim()) params.set("q", manualQuery.trim());
        const res = await fetch(`/api/facturas?${params}`);
        const data = await res.json();
        if (!cancelled) setManualResults(Array.isArray(data) ? data : []);
      } catch { if (!cancelled) setManualResults([]); }
      finally { if (!cancelled) setManualLoading(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [expandedId, manualOpen, manualTipo, manualQuery, activeCompany]);

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
    // Reset de la búsqueda manual; arranca con el tipo probable según el signo.
    setManualOpen(false); setManualQuery(""); setManualResults([]);
    setManualTipo(tx.monto < 0 ? "EGRESO" : "INGRESO");
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

  // Categorizar sin factura (o ignorar): PATCH ignore + tag en notes.
  async function categorizar(txId: string, tag: string | null, label: string) {
    setActing(txId);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignore", notes: tag }),
      });
      if (res.ok) { showToast(`Categorizado: ${label}`); setExpandedId(null); await Promise.all([loadTxs(), loadAccounts()]); }
      else showToast("No se pudo categorizar");
    } finally { setActing(null); }
  }

  async function reabrir(txId: string) {
    setActing(txId);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unignore" }),
      });
      if (res.ok) { showToast("Movimiento reabierto"); await Promise.all([loadTxs(), loadAccounts()]); }
    } finally { setActing(null); }
  }

  async function eliminarCuenta(acc: BankAccount) {
    if (!window.confirm(`¿Eliminar la cuenta ${acc.banco} ••${acc.numeroCuenta.slice(-4)}? También se borrarán sus movimientos.`)) return;
    const res = await fetch(`/api/bancos/${acc.id}`, { method: "DELETE" });
    if (res.ok) { showToast("Cuenta eliminada"); setSelectedId(null); await loadAccounts(); }
    else showToast("No se pudo eliminar la cuenta");
  }

  // ── Selección en lote ──────────────────────────────────────────────────────
  function togglePick(id: string) {
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const pickedIds = [...picked];
  // Neto firmado (un reembolso resta) — coincide con el motor de conciliación.
  const pickedSum = Math.abs(txs.filter((t) => picked.has(t.id)).reduce((s, t) => s + t.monto, 0));

  async function bulkCategorizar(tag: string | null, label: string) {
    if (pickedIds.length === 0) return;
    setActing("__bulk__");
    try {
      await Promise.all(pickedIds.map((id) =>
        fetch(`/api/bancos/transactions/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "ignore", notes: tag }),
        })
      ));
      showToast(`${pickedIds.length} movimiento(s): ${label}`);
      setPicked(new Set()); setSelectMode(false);
      await Promise.all([loadTxs(), loadAccounts()]);
    } finally { setActing(null); }
  }

  function statusChip(tx: BankTx) {
    if (tx.status === "MATCHED") return <Chip status="conciliado" label="Conciliado" icon={<CheckCircle2 className="h-3 w-3" />} />;
    if (tx.status === "IGNORED") {
      const lbl = tx.notes && TAG_LABEL[tx.notes] ? TAG_LABEL[tx.notes] : "Ignorado";
      return <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-slate-tint px-2.5 py-1 text-[12px] font-semibold text-cos-ink-soft">{lbl}</span>;
    }
    return <Chip status="sin_conciliar" label="Sin conciliar" icon={<AlertTriangle className="h-3 w-3" />} />;
  }

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;

  return (
    <div className="mx-auto max-w-[1060px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Bancos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">Conectamos los movimientos de tu banco con tus facturas para que todo cuadre.</p>
        </div>
        <button onClick={() => setAccountModal({ account: null })} className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-4 py-2 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper">
          <Plus className="h-4 w-4" /> Agregar cuenta
        </button>
      </div>

      {accounts.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line p-10 text-center shadow-card">
          <Landmark className="mx-auto mb-3 h-10 w-10 text-cos-ink-faint opacity-40" />
          <p className="text-sm font-medium text-cos-ink">Sin cuentas bancarias</p>
          <button onClick={() => setAccountModal({ account: null })} className="mt-2 inline-block text-[13px] font-semibold text-cos-brand-ink hover:underline">Agregar una cuenta →</button>
        </Card>
      ) : (
        <>
          {/* account selector */}
          <div className="mt-4 flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button key={a.id} onClick={() => setSelectedId(a.id)}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (a.id === selectedId ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                {a.banco} <span className="font-mono text-[12px] opacity-80">••{a.numeroCuenta.slice(-4)}</span>
              </button>
            ))}
            <button onClick={() => setAccountModal({ account: null })} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-cos-line bg-cos-card px-3.5 py-2 text-[13.5px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint">
              <Plus className="h-3.5 w-3.5" /> Agregar
            </button>
          </div>

          {/* account card */}
          {account && (
            <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
              <div className="flex items-center gap-3.5">
                <div className="grid h-[42px] w-[42px] flex-none place-items-center rounded-[12px] bg-cos-brand-tint text-cos-brand-ink"><Landmark className="h-[22px] w-[22px]" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold text-cos-ink">{account.banco}</p>
                  <p className="truncate text-[13px] text-cos-ink-soft">{account.titular ?? account.nombre} · <span className="font-mono">••••{account.numeroCuenta.slice(-4)}</span></p>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  {account.stats.unmatched > 0
                    ? <Chip status="sin_conciliar" label={`${account.stats.unmatched} por conciliar`} />
                    : <Chip status="conciliado" label="Todo cuadrado" />}
                  <button onClick={() => setAccountModal({ account })} title="Editar cuenta"
                    className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"><Pencil className="h-[15px] w-[15px]" /></button>
                  <button onClick={() => eliminarCuenta(account)} title="Eliminar cuenta"
                    className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-red-tint hover:text-cos-red-ink"><Trash2 className="h-[15px] w-[15px]" /></button>
                </div>
              </div>
              <div className="my-[18px] flex flex-col gap-1.5 border-y border-cos-line-soft py-4">
                <span className={LBL}>Saldo en banco</span>
                {account.lastTransaction?.saldo != null
                  ? <Money value={account.lastTransaction.saldo} size={30} weight={700} />
                  : <span className="font-mono text-[20px] text-cos-ink-faint">—</span>}
              </div>
              <div className="flex flex-wrap gap-2.5">
                <label className={"flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper " + (busy ? "pointer-events-none opacity-50" : "")}>
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

          {/* filter bar */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {([["all","Todos"],["UNMATCHED","Sin conciliar"],["MATCHED","Conciliados"]] as [Filter,string][]).map(([k, t]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (filter === k ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                {t} <span className="font-mono text-[12px] opacity-80">{k === "all" ? (counts.total ?? 0) : k === "UNMATCHED" ? (counts.UNMATCHED ?? 0) : (counts.MATCHED ?? 0)}</span>
              </button>
            ))}
            <button onClick={() => setShowMore((v) => !v)}
              className={"inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint " + (showMore ? "bg-cos-brand-tint" : "")}>
              <SlidersHorizontal className="h-3.5 w-3.5" /> Más filtros
              <ChevronDown className={"h-3.5 w-3.5 transition-transform " + (showMore ? "rotate-180" : "")} />
            </button>
            <span className="flex-1" />
            <button onClick={() => { setSelectMode((v) => !v); setPicked(new Set()); }}
              className={"inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold " + (selectMode ? "bg-cos-ink text-white" : "text-cos-ink-soft hover:bg-cos-paper")}>
              <CheckSquare className="h-4 w-4" /> {selectMode ? "Salir de selección" : "Seleccionar"}
            </button>
          </div>

          {/* secondary type filters */}
          {showMore && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-cos-line bg-cos-paper px-4 py-3">
              <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.08em] text-cos-ink-faint">Por tipo</span>
              {TIPO_CHIPS.map(({ f, t, k }) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium " + (filter === f ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                  {t} <span className="font-mono text-[11px] opacity-70">{counts[k] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {/* movements */}
          <div className="mt-3 flex flex-col gap-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
            ) : txs.length === 0 ? (
              <Card className="rounded-card border-cos-line p-10 text-center text-cos-ink-faint shadow-card">No hay movimientos con ese filtro.</Card>
            ) : txs.map((m) => {
              const matched = m.status === "MATCHED";
              const ignored = m.status === "IGNORED";
              const isPicked = picked.has(m.id);
              return (
                <Card key={m.id} className={"rounded-card p-4 shadow-card " + (matched ? "border-cos-jade-tint bg-cos-jade-tint/40" : "border-cos-line")}>
                  <div className="flex items-start gap-3">
                    {selectMode && (
                      <button onClick={() => togglePick(m.id)} className="mt-1 flex-none">
                        {isPicked
                          ? <CheckSquare className="h-[18px] w-[18px] text-cos-brand" />
                          : <span className="block h-[18px] w-[18px] rounded-[5px] border-[1.5px] border-cos-line" />}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
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
                        {statusChip(m)}
                      </div>

                      {matched && m.invoice && (
                        <div className="mt-3 flex items-center gap-1.5 border-t border-dashed border-cos-jade-tint pt-3 text-[13px] text-cos-jade-ink">
                          <Link2 className="h-[15px] w-[15px]" /> Conciliado con <b>{m.invoice.customer?.razonSocial ?? "factura"}</b>
                        </div>
                      )}

                      {ignored && !selectMode && (
                        <div className="mt-3 border-t border-dashed border-cos-line pt-3">
                          <button onClick={() => reabrir(m.id)} disabled={acting === m.id}
                            className="text-[13px] font-semibold text-cos-brand-ink hover:underline disabled:opacity-50">
                            {acting === m.id ? "…" : "Reabrir movimiento"}
                          </button>
                        </div>
                      )}

                      {!matched && !ignored && !selectMode && (
                        <div className="mt-3 border-t border-dashed border-cos-line pt-3">
                          <button onClick={() => expand(m)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-cos-brand-ink hover:underline">
                            <Search className="h-[15px] w-[15px]" /> {expandedId === m.id ? "Ocultar" : "Buscar coincidencia"}
                          </button>
                          {expandedId === m.id && (
                            <div className="mt-3 flex flex-col gap-3">
                              {candLoading ? (
                                <span className="inline-flex items-center gap-2 text-[13px] text-cos-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando facturas…</span>
                              ) : candidates.length > 0 ? (
                                <>
                                  <p className="text-[12.5px] font-semibold text-cos-ink">Coincidencias sugeridas</p>
                                  <div className="flex flex-col gap-2">
                                    {candidates.map((c) => (
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
                                </>
                              ) : (
                                <span className="text-[13px] text-cos-ink-faint">Sin coincidencias automáticas.</span>
                              )}

                              <div className="rounded-control border border-cos-line">
                                <button onClick={() => setManualOpen((o) => !o)}
                                  className="flex w-full items-center gap-2 px-3 py-2.5 text-[13px] text-cos-ink-faint hover:text-cos-brand-ink">
                                  <Search className="h-[15px] w-[15px]" /> Buscar otra factura por cliente, folio o monto…
                                  <ChevronDown className={"ml-auto h-3.5 w-3.5 transition-transform " + (manualOpen ? "rotate-180" : "")} />
                                </button>
                                {manualOpen && (
                                  <div className="border-t border-cos-line-soft p-2.5">
                                    <div className="mb-2 flex gap-1.5">
                                      {(["INGRESO","EGRESO","NOMINA"] as const).map((t) => (
                                        <button key={t} onClick={() => setManualTipo(t)}
                                          className={"rounded-full px-2.5 py-1 text-[12px] font-medium " + (manualTipo === t ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink-soft hover:bg-cos-line-soft")}>
                                          {t === "INGRESO" ? "Ingresos" : t === "EGRESO" ? "Gastos" : "Nómina"}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="flex items-center gap-2 rounded-control border border-cos-line px-2.5 py-1.5">
                                      <Search className="h-4 w-4 text-cos-ink-faint" />
                                      <input value={manualQuery} onChange={(e) => setManualQuery(e.target.value)} autoFocus
                                        placeholder="Cliente, RFC, UUID, folio…"
                                        className="w-full bg-transparent text-[13px] outline-none placeholder:text-cos-ink-faint" />
                                    </div>
                                    <div className="mt-2 max-h-[40vh] overflow-y-auto">
                                      {manualLoading ? (
                                        <div className="flex items-center gap-2 py-3 text-[12.5px] text-cos-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando…</div>
                                      ) : manualResults.length === 0 ? (
                                        <p className="py-3 text-center text-[12.5px] text-cos-ink-faint">Sin facturas por conciliar con ese criterio.</p>
                                      ) : manualResults.map((f) => (
                                        <div key={f.id} className="flex items-center justify-between gap-3 border-b border-cos-line-soft py-2 last:border-0">
                                          <div className="min-w-0">
                                            <p className="truncate text-[13px] font-medium text-cos-ink">{f.customer?.razonSocial ?? "—"}</p>
                                            <p className="text-[11.5px] text-cos-ink-faint"><span className="font-mono">{f.customer?.rfc ?? "—"}</span>{f.folio ? ` · ${f.serie ?? ""}${f.folio}` : ""} · {fmtFecha(f.fecha)} · <Money value={f.total} size={11.5} muted /></p>
                                          </div>
                                          <button onClick={() => conciliar(m.id, f.id)} className="flex-none rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep">Conciliar</button>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-3">
                                <span className="h-px flex-1 bg-cos-line-soft" />
                                <span className="text-[12px] text-cos-ink-faint">o categoriza sin factura</span>
                                <span className="h-px flex-1 bg-cos-line-soft" />
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {CATEGORIAS.map(({ tag, label, icon: Icon }) => (
                                  <button key={label} onClick={() => categorizar(m.id, tag, label)} disabled={acting === m.id}
                                    className={"inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13px] font-medium hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink disabled:opacity-50 " + (tag === null ? "text-cos-ink-faint" : "text-cos-ink-soft")}>
                                    <Icon className="h-[15px] w-[15px] opacity-70" /> {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* bulk action bar (sticky, only in select mode) */}
          {selectMode && picked.size > 0 && (
            <div className="sticky bottom-5 z-[80] mt-5 flex flex-wrap items-center justify-between gap-3 rounded-card bg-cos-ink px-5 py-3.5 text-white shadow-[0_18px_40px_-16px_oklch(0.2_0.05_258/0.6)]">
              <span className="text-[14px] font-semibold">{picked.size} movimiento(s) · <span className="font-mono">${pickedSum.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></span>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => bulkCategorizar("TAX_PAYMENT", "Pago de impuestos")} disabled={acting === "__bulk__"}
                  className="rounded-control bg-white/15 px-3.5 py-2 text-[13.5px] font-semibold hover:bg-white/25 disabled:opacity-50">Impuestos</button>
                <button onClick={() => bulkCategorizar("INTERNAL_TRANSFER", "Transferencia")} disabled={acting === "__bulk__"}
                  className="rounded-control bg-white/15 px-3.5 py-2 text-[13.5px] font-semibold hover:bg-white/25 disabled:opacity-50">Transferencia</button>
                <button onClick={() => bulkCategorizar(null, "Ignorar")} disabled={acting === "__bulk__"}
                  className="rounded-control bg-white/15 px-3.5 py-2 text-[13.5px] font-semibold hover:bg-white/25 disabled:opacity-50">Ignorar</button>
                <button onClick={() => setBulkMatchOpen(true)} disabled={acting === "__bulk__"}
                  className="rounded-control bg-cos-brand px-3.5 py-2 text-[13.5px] font-semibold hover:bg-cos-brand-deep disabled:opacity-50">
                  {acting === "__bulk__" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Conciliar en lote"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {bulkMatchOpen && selectedId && activeCompany && (
        <BulkMatchModal
          companyId={activeCompany.id}
          count={picked.size}
          sum={pickedSum}
          onClose={() => setBulkMatchOpen(false)}
          onConfirm={async (invoiceId) => {
            const res = await fetch("/api/bancos/batch-match", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txIds: pickedIds, invoiceId }),
            });
            setBulkMatchOpen(false);
            if (res.ok) { showToast(`${picked.size} movimiento(s) conciliado(s)`); setPicked(new Set()); setSelectMode(false); await Promise.all([loadTxs(), loadAccounts()]); }
            else showToast("No se pudo conciliar en lote");
          }}
        />
      )}

      {accountModal && activeCompany && (
        <AccountModal
          companyId={activeCompany.id}
          account={accountModal.account}
          onClose={() => setAccountModal(null)}
          onSaved={async () => { setAccountModal(null); await loadAccounts(); }}
        />
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-xl bg-cos-ink px-5 py-3 text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}

// ── Modal: conciliar N movimientos con una factura ──────────────────────────────
interface FacturaSearch {
  id: string; uuid: string | null; folio: string | null; serie: string | null;
  fecha: string; total: number; tipo: string;
  customer: { razonSocial: string; rfc: string } | null;
  matchedAmount: number; fullyMatched: boolean;
}
function BulkMatchModal({
  companyId, count, sum, onClose, onConfirm,
}: {
  companyId: string; count: number; sum: number;
  onClose: () => void; onConfirm: (invoiceId: string) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [tipo, setTipo] = useState<"EGRESO" | "INGRESO" | "NOMINA">("INGRESO");
  const [results, setResults] = useState<FacturaSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<FacturaSearch | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ companyId, tipo, take: "30", unmatchedOnly: "true" });
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/facturas?${params}`);
        const data = await res.json();
        if (!cancelled) setResults(Array.isArray(data) ? data : []);
      } catch { if (!cancelled) setResults([]); }
      finally { if (!cancelled) setLoading(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, tipo, companyId]);

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-[520px] rounded-card border-cos-line p-5 shadow-card" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[16px] font-semibold text-cos-ink">Conciliar {count} movimiento(s) con una factura</p>
              <p className="mt-0.5 text-[13px] text-cos-ink-soft">Suma seleccionada: <span className="font-mono font-semibold">${sum.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></p>
            </div>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper"><X className="h-5 w-5" /></button>
          </div>

          <div className="mt-3 flex gap-1.5">
            {(["INGRESO","EGRESO","NOMINA"] as const).map((t) => (
              <button key={t} onClick={() => setTipo(t)}
                className={"rounded-full px-3 py-1 text-[12.5px] font-medium " + (tipo === t ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink-soft hover:bg-cos-line-soft")}>
                {t === "INGRESO" ? "Ingresos" : t === "EGRESO" ? "Gastos (Egreso)" : "Nómina"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-control border border-cos-line px-3 py-2">
            <Search className="h-4 w-4 text-cos-ink-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por proveedor, RFC, UUID, folio…"
              className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-cos-ink-faint" autoFocus />
          </div>

          <div className="mt-3 max-h-[44vh] overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-[13px] text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Buscando…</div>
            ) : results.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-cos-ink-faint">Sin facturas por conciliar.</p>
            ) : results.map((f) => (
              <button key={f.id} onClick={() => setPicked(f)}
                className={"flex w-full items-center justify-between gap-3 border-b border-cos-line-soft px-1 py-2.5 text-left last:border-0 " + (picked?.id === f.id ? "bg-cos-brand-tint" : "hover:bg-cos-paper")}>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">{f.customer?.razonSocial ?? "—"}</p>
                  <p className="text-[12px] text-cos-ink-faint"><span className="font-mono">{f.customer?.rfc ?? "—"}</span>{f.folio ? ` · ${f.serie ?? ""}${f.folio}` : ""} · {fmtFecha(f.fecha)}</p>
                </div>
                <Money value={f.total} size={13} weight={600} />
              </button>
            ))}
          </div>

          {picked && (
            <div className="mt-3 rounded-control bg-cos-paper px-3 py-2.5 text-[13px]">
              <div className="flex justify-between"><span className="text-cos-ink-soft">Factura total</span><Money value={picked.total} size={13} weight={600} /></div>
              <div className="flex justify-between"><span className="text-cos-ink-soft">Suma seleccionada</span><span className="font-mono font-semibold">${sum.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
              <div className="flex justify-between">
                <span className="text-cos-ink-soft">Cobertura</span>
                <span className={"font-semibold " + (picked.total > 0 && sum / picked.total > 1.001 ? "text-cos-red-ink" : "text-cos-jade-ink")}>
                  {picked.total > 0 ? Math.round((sum / picked.total) * 100) : 0}%{picked.total > 0 && sum / picked.total > 1.001 ? " (excede)" : ""}
                </span>
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper">Cancelar</button>
            <button disabled={!picked || confirming} onClick={async () => { if (!picked) return; setConfirming(true); try { await onConfirm(picked.id); } finally { setConfirming(false); } }}
              className="rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {confirming ? "Conciliando…" : "Conciliar"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── Modal: agregar / editar cuenta bancaria ─────────────────────────────────────
function AccountModal({
  companyId, account, onClose, onSaved,
}: {
  companyId: string;
  account: BankAccount | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const isEdit = !!account;
  const [banco, setBanco] = useState(account?.banco ?? "BBVA");
  const [nombre, setNombre] = useState(account?.nombre ?? "");
  const [numeroCuenta, setNumeroCuenta] = useState(account?.numeroCuenta ?? "");
  const [clabe, setClabe] = useState(account?.clabe ?? "");
  const [moneda, setMoneda] = useState(account?.moneda ?? "MXN");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!nombre.trim() || !numeroCuenta.trim()) {
      setError("Nombre y número de cuenta son obligatorios.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = { banco, nombre: nombre.trim(), numeroCuenta: numeroCuenta.trim(), clabe: clabe.trim(), moneda };
      const res = isEdit
        ? await fetch(`/api/bancos/${account!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch(`/api/bancos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, ...body }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "No se pudo guardar la cuenta.");
        return;
      }
      await onSaved();
    } catch {
      setError("No se pudo guardar la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-[480px] rounded-card border-cos-line p-5 shadow-card">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[16px] font-semibold text-cos-ink">{isEdit ? "Editar cuenta" : "Agregar cuenta"}</p>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper"><X className="h-5 w-5" /></button>
          </div>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Banco</span>
              <select value={banco} onChange={(e) => setBanco(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none focus:border-cos-brand">
                {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Nombre / alias de la cuenta</span>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Cuenta principal MXN"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" autoFocus />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Número de cuenta</span>
              <input value={numeroCuenta} onChange={(e) => setNumeroCuenta(e.target.value)} placeholder="Ej. 0123456789"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] font-mono text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">CLABE <span className="text-cos-ink-faint">(opcional)</span></span>
              <input value={clabe} onChange={(e) => setClabe(e.target.value)} placeholder="18 dígitos"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] font-mono text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Moneda</span>
              <select value={moneda} onChange={(e) => setMoneda(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none focus:border-cos-brand">
                <option value="MXN">MXN — Peso mexicano</option>
                <option value="USD">USD — Dólar estadounidense</option>
                <option value="EUR">EUR — Euro</option>
              </select>
            </label>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-cos-red-ink">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper">Cancelar</button>
            <button disabled={saving} onClick={save}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isEdit ? "Guardar cambios" : "Agregar cuenta"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
