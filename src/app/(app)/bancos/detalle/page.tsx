"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Upload, Zap, ChevronDown,
  CheckCircle2, AlertCircle, Loader2, X,
  ArrowDownLeft, ArrowUpRight, Landmark,
  Link as LinkIcon, Unlink, Search,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface BankAccount {
  id: string; banco: string; nombre: string; numeroCuenta: string;
  clabe?: string; moneda: string;
  lastTransaction?: { fecha: string; saldo?: number } | null;
  stats: { total: number; unmatched: number; matched: number; ignored: number };
}
interface InvoiceRef {
  id: string; uuid?: string | null; total: number; fecha: string;
  customer?: { razonSocial: string } | null;
}
interface BankTx {
  id: string; fecha: string; descripcion: string; monto: number;
  referencia?: string | null; saldo?: number | null;
  tipo: "CREDITO" | "DEBITO"; status: "UNMATCHED" | "MATCHED" | "IGNORED";
  invoiceId?: string | null; notes?: string | null;
  invoice?: InvoiceRef | null;
  // Construcción-side links (from bartiz). These show as "↳ Gasto …",
  // "↳ Reembolso …", "↳ Raya …" under the description so admins know
  // which bartiz entity this bank movement settles.
  gastoPagado?: { id: string; beneficiarioNombre: string; importe: number; descripcion: string; proyecto?: { codigo: string } | null } | null;
  reembolsoPagado?: { id: string; totalReembolso: number; semanaInicio: string; semanaFin: string; proyecto?: { codigo: string } | null } | null;
  rayaPagada?: { id: string; totalDestajo: number; cuadrilla?: { nombre: string } | null; proyecto?: { codigo: string } | null } | null;
}
interface Candidate {
  id: string; uuid?: string | null; fecha: string; total: number;
  cliente: string; rfc: string; score: number;
  folio?: string | null; serie?: string | null; metodoPago?: string;
  confidence: "alta" | "media" | "baja";
  alreadyMatched?: boolean;
  matchedAmount?: number;
  remainingBalance?: number;
}

type TxFilter =
  | "all"
  | "UNMATCHED"
  | "MATCHED"
  | "PENDING"
  | "TAX_PAYMENT"
  | "PAYROLL_NO_CFDI"
  | "LOAN_RECEIVED"
  | "LOAN_GIVEN"
  | "CAPITAL_CONTRIBUTION"
  | "NON_DEDUCTIBLE"
  | "INTERNAL_TRANSFER"
  | "IGNORED";

type StatusCounts = {
  UNMATCHED: number;
  MATCHED: number;
  PENDING: number;
  TAX_PAYMENT: number;
  PAYROLL_NO_CFDI: number;
  LOAN_RECEIVED: number;
  LOAN_GIVEN: number;
  CAPITAL_CONTRIBUTION: number;
  NON_DEDUCTIBLE: number;
  INTERNAL_TRANSFER: number;
  IGNORED: number;
  total: number;
};

const EMPTY_COUNTS: StatusCounts = {
  UNMATCHED: 0, MATCHED: 0, PENDING: 0, TAX_PAYMENT: 0,
  PAYROLL_NO_CFDI: 0, LOAN_RECEIVED: 0, LOAN_GIVEN: 0, CAPITAL_CONTRIBUTION: 0,
  NON_DEDUCTIBLE: 0, INTERNAL_TRANSFER: 0, IGNORED: 0, total: 0,
};

const BANKS = ["BBVA","Banamex","Santander","Banorte","HSBC","Scotiabank","Afirme","Inbursa","BanBajío","Otro"];
const CONFIDENCE_COLORS = {
  alta:  "bg-green-100 text-green-700",
  media: "bg-amber-100 text-amber-700",
  baja:  "bg-gray-100 text-gray-500",
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function BancosPage() {
  const { activeCompany } = useCompany();
  const [accounts, setAccounts]         = useState<BankAccount[]>([]);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [txs, setTxs]                   = useState<BankTx[]>([]);
  const [filter, setFilter]             = useState<TxFilter>("all");
  const [statusCounts, setStatusCounts] = useState<StatusCounts>(EMPTY_COUNTS);
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [showBulkMatch, setShowBulkMatch] = useState(false);
  const [page, setPage]                 = useState(1);
  const [totalPages, setTotalPages]     = useState(1);
  const [loading, setLoading]           = useState(false);
  const [txLoading, setTxLoading]       = useState(false);
  const [error, setError]               = useState("");

  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showUpload, setShowUpload]         = useState(false);

  const [expandedTxId, setExpandedTxId]           = useState<string | null>(null);
  const [candidates, setCandidates]               = useState<Candidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [matchingTxId, setMatchingTxId]           = useState<string | null>(null);

  const selectedAccount = accounts.find(a => a.id === selectedId);

  // ── Load accounts ──────────────────────────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/bancos?companyId=${activeCompany.id}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setAccounts(list);
      if (!selectedId && list.length > 0) setSelectedId(list[0].id);
    } catch { setError("Error al cargar cuentas"); }
    finally { setLoading(false); }
  }, [activeCompany, selectedId]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // ── Load transactions ──────────────────────────────────────────────────────
  const loadTxs = useCallback(async () => {
    if (!selectedId) return;
    setTxLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (filter !== "all") params.set("status", filter);
      const res  = await fetch(`/api/bancos/${selectedId}?${params}`);
      const data = await res.json();
      setTxs(data.transactions ?? []);
      setStatusCounts({ ...EMPTY_COUNTS, ...(data.statusCounts ?? {}) });
      setTotalPages(data.pagination?.pages ?? 1);
    } catch { setError("Error al cargar movimientos"); }
    finally { setTxLoading(false); }
  }, [selectedId, filter, page]);

  useEffect(() => {
    setPage(1);
    setExpandedTxId(null);
    setSelectedTxIds(new Set());
  }, [selectedId, filter]);
  useEffect(() => { loadTxs(); }, [loadTxs]);

  const selectionCount = selectedTxIds.size;
  const selectionSum = txs
    .filter((t) => selectedTxIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.monto), 0);

  function toggleTxSelection(id: string) {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    const ids = new Set(txs.map((t) => t.id));
    setSelectedTxIds(ids);
  }

  function clearSelection() {
    setSelectedTxIds(new Set());
  }

  async function handleBulkMatch(invoiceId: string) {
    const res = await fetch(`/api/bancos/batch-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txIds: Array.from(selectedTxIds), invoiceId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Error al conciliar en lote");
      return;
    }
    const coverage = Math.round((data.coverage ?? 0) * 100);
    setError(
      `✓ ${data.matched} movimiento(s) conciliados. Total movimientos: ${formatCurrency(
        data.sumMatched
      )} · Factura: ${formatCurrency(data.invoiceTotal)} (${coverage}%)`
    );
    clearSelection();
    setShowBulkMatch(false);
    loadTxs();
    loadAccounts();
  }

  // ── Auto-match ─────────────────────────────────────────────────────────────
  async function handleAutoMatch() {
    if (!selectedId) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/bancos/${selectedId}/match`, { method: "POST" });
      const data = await res.json();
      setError(data.autoMatched > 0
        ? `✓ ${data.autoMatched} movimiento(s) conciliados automáticamente`
        : "No se encontraron coincidencias de alta confianza. Revisa manualmente.");
      if (data.autoMatched > 0) { loadAccounts(); loadTxs(); }
    } catch { setError("Error en conciliación automática"); }
    finally { setLoading(false); }
  }

  // ── Expand transaction for manual match ───────────────────────────────────
  async function toggleExpand(txId: string) {
    if (expandedTxId === txId) { setExpandedTxId(null); return; }
    setExpandedTxId(txId);
    setCandidates([]);
    setCandidatesLoading(true);
    try {
      const res  = await fetch(`/api/bancos/${selectedId}/match?txId=${txId}`);
      const data = await res.json();
      setCandidates(data.candidates ?? []);
    } catch { setCandidates([]); }
    finally { setCandidatesLoading(false); }
  }

  // ── Apply action ──────────────────────────────────────────────────────────
  async function applyAction(txId: string, action: string, invoiceId?: string, notes?: string) {
    setMatchingTxId(txId);
    try {
      await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, invoiceId, notes }),
      });
      setExpandedTxId(null);
      loadTxs();
      loadAccounts();
    } catch { setError("Error al actualizar movimiento"); }
    finally { setMatchingTxId(null); }
  }

  if (!activeCompany) return (
    <div className="p-8 text-muted-foreground text-sm">
      Selecciona una empresa para ver sus cuentas bancarias.
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold">Bancos y Conciliación</h1>
          <p className="text-muted-foreground text-sm mt-0.5 truncate">{activeCompany.razonSocial}</p>
        </div>
        <button onClick={() => setShowAddAccount(true)}
          className="shrink-0 flex items-center gap-2 bg-primary text-primary-foreground px-3 sm:px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors">
          <Plus className="h-4 w-4" /><span className="hidden sm:inline">Agregar cuenta</span><span className="sm:hidden">Cuenta</span>
        </button>
      </div>

      {error && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓")
            ? "bg-green-50 border border-green-200 text-green-700"
            : "bg-red-50 border border-red-200 text-red-700"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          {error}
          <button onClick={() => setError("")} className="ml-auto"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {accounts.length > 0 ? (
        <>
          {/* Account tabs */}
          <div className="flex gap-3 flex-wrap mb-6">
            {accounts.map(acc => (
              <AccountCard key={acc.id} account={acc}
                selected={selectedId === acc.id}
                onSelect={() => { setSelectedId(acc.id); setFilter("all"); }} />
            ))}
          </div>

          {/* Transaction panel */}
          {selectedAccount && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              {/* Panel header */}
              <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold text-sm truncate">{selectedAccount.banco} — {selectedAccount.nombre}</h2>
                  <p className="text-xs text-muted-foreground">••••{selectedAccount.numeroCuenta.slice(-4)}</p>
                </div>
                <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2">
                  <button onClick={() => setShowUpload(true)}
                    className="flex-1 sm:flex-none justify-center flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-md text-xs font-medium hover:bg-accent transition-colors">
                    <Upload className="h-3.5 w-3.5" />Cargar estado de cuenta
                  </button>
                  <button onClick={handleAutoMatch} disabled={loading}
                    className="flex-1 sm:flex-none justify-center flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    Conciliar automáticamente
                  </button>
                </div>
              </div>

              {/* Filter tabs — single scrollable row on mobile, wraps on desktop */}
              <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center gap-2 overflow-x-auto sm:flex-wrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {([
                  ["all",                  "Todos",                  statusCounts.total],
                  ["UNMATCHED",            "Sin conciliar",          statusCounts.UNMATCHED],
                  ["MATCHED",              "Conciliados",            statusCounts.MATCHED],
                  ["PENDING",              "Pendiente CFDI",         statusCounts.PENDING],
                  ["TAX_PAYMENT",          "Impuestos",              statusCounts.TAX_PAYMENT],
                  ["PAYROLL_NO_CFDI",      "Nómina",                 statusCounts.PAYROLL_NO_CFDI],
                  ["LOAN_RECEIVED",        "Préstamos",              statusCounts.LOAN_RECEIVED],
                  ["LOAN_GIVEN",           "Préstamos otorgados",    statusCounts.LOAN_GIVEN],
                  ["CAPITAL_CONTRIBUTION", "Capital",                statusCounts.CAPITAL_CONTRIBUTION],
                  ["INTERNAL_TRANSFER",    "Transferencias",         statusCounts.INTERNAL_TRANSFER],
                  ["NON_DEDUCTIBLE",       "No deducible",           statusCounts.NON_DEDUCTIBLE],
                  ["IGNORED",              "Ignorados",              statusCounts.IGNORED],
                ] as const).map(([f, label, count]) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      filter === f
                        ? "bg-primary text-primary-foreground"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}>
                    {label}{count > 0 ? ` (${count})` : ""}
                  </button>
                ))}
              </div>

              {/* Bulk-match selection bar (only shown when user selected rows) */}
              {selectionCount > 0 && (
                <div className="px-4 sm:px-5 py-3 bg-blue-50 border-b border-blue-200 flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm text-blue-900">
                    <strong>{selectionCount}</strong> movimiento{selectionCount === 1 ? "" : "s"} seleccionado{selectionCount === 1 ? "" : "s"} ·{" "}
                    <strong>{formatCurrency(selectionSum)}</strong>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={clearSelection}
                      className="text-xs text-blue-900 hover:underline"
                    >
                      Limpiar
                    </button>
                    <button
                      onClick={() => setShowBulkMatch(true)}
                      className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-xs font-medium hover:bg-primary/90"
                    >
                      <LinkIcon className="h-3.5 w-3.5" /> Conciliar con factura…
                    </button>
                  </div>
                </div>
              )}

              {/* Transactions */}
              {txLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
                  <Loader2 className="h-5 w-5 animate-spin" />Cargando movimientos...
                </div>
              ) : txs.length === 0 ? (
                <div className="py-12 text-center">
                  <Landmark className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
                  <p className="font-medium text-sm">Sin movimientos</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {filter === "all"
                      ? "Carga un estado de cuenta para empezar."
                      : `No hay movimientos "${filter.toLowerCase()}".`}
                  </p>
                </div>
              ) : (
                <>
                  {/* Desktop: table */}
                  <table className="hidden md:table w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-gray-50">
                        <th className="px-3 py-2.5 w-8">
                          <input
                            type="checkbox"
                            checked={txs.length > 0 && selectedTxIds.size === txs.length}
                            onChange={(e) => (e.target.checked ? selectAllVisible() : clearSelection())}
                            className="h-3.5 w-3.5 rounded border-border cursor-pointer"
                            title="Seleccionar todos los visibles"
                          />
                        </th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Descripción</th>
                        <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Monto</th>
                        <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Saldo</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Estado</th>
                        <th className="px-4 py-2.5 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map(tx => (
                        <Fragment key={tx.id}>
                          <TxRow tx={tx}
                            expanded={expandedTxId === tx.id}
                            acting={matchingTxId === tx.id}
                            selected={selectedTxIds.has(tx.id)}
                            onToggleSelect={() => toggleTxSelection(tx.id)}
                            onExpand={() => toggleExpand(tx.id)}
                            onIgnore={() => applyAction(tx.id, "ignore")}
                            onUnmatch={() => applyAction(tx.id, "unmatch")}
                            onUnignore={() => applyAction(tx.id, "unignore")}
                          />
                          {expandedTxId === tx.id && (
                            <tr>
                              <td colSpan={7} className="bg-blue-50/60 border-b border-border px-5 pb-4 pt-2">
                                <MatchPanel
                                  tx={tx}
                                  candidates={candidates}
                                  loading={candidatesLoading}
                                  onMatch={(id) => applyAction(tx.id, "match", id)}
                                  onIgnore={() => applyAction(tx.id, "ignore")}
                                  onCategorize={(tag) => applyAction(tx.id, "ignore", undefined, tag)}
                                  onClose={() => setExpandedTxId(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>

                  {/* Mobile: card list (the table overflows horizontally and hides Monto) */}
                  <div className="md:hidden">
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-gray-50 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={txs.length > 0 && selectedTxIds.size === txs.length}
                        onChange={(e) => (e.target.checked ? selectAllVisible() : clearSelection())}
                        className="h-4 w-4 rounded border-border cursor-pointer"
                        title="Seleccionar todos los visibles"
                      />
                      <span>Seleccionar todos · {txs.length} movimiento{txs.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="divide-y divide-border">
                      {txs.map(tx => (
                        <div key={tx.id}>
                          <TxCard tx={tx}
                            expanded={expandedTxId === tx.id}
                            acting={matchingTxId === tx.id}
                            selected={selectedTxIds.has(tx.id)}
                            onToggleSelect={() => toggleTxSelection(tx.id)}
                            onExpand={() => toggleExpand(tx.id)}
                            onIgnore={() => applyAction(tx.id, "ignore")}
                            onUnmatch={() => applyAction(tx.id, "unmatch")}
                            onUnignore={() => applyAction(tx.id, "unignore")}
                          />
                          {expandedTxId === tx.id && (
                            <div className="bg-blue-50/60 border-b border-border px-4 pb-4 pt-2">
                              <MatchPanel
                                tx={tx}
                                candidates={candidates}
                                loading={candidatesLoading}
                                onMatch={(id) => applyAction(tx.id, "match", id)}
                                onIgnore={() => applyAction(tx.id, "ignore")}
                                onCategorize={(tag) => applyAction(tx.id, "ignore", undefined, tag)}
                                onClose={() => setExpandedTxId(null)}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-3 px-5 py-3 border-t border-border">
                      <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                        className="text-xs px-3 py-1.5 border border-border rounded-md disabled:opacity-40 hover:bg-accent">
                        Anterior
                      </button>
                      <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
                      <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                        className="text-xs px-3 py-1.5 border border-border rounded-md disabled:opacity-40 hover:bg-accent">
                        Siguiente
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      ) : !loading && (
        <div className="bg-white rounded-xl border border-border shadow-sm p-12 text-center">
          <Landmark className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-20" />
          <p className="font-semibold text-sm mb-1">No hay cuentas bancarias</p>
          <p className="text-xs text-muted-foreground mb-4">
            Agrega tu primera cuenta para empezar la conciliación.
          </p>
          <button onClick={() => setShowAddAccount(true)}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors">
            <Plus className="h-4 w-4" />Agregar cuenta
          </button>
        </div>
      )}

      {showAddAccount && (
        <AddAccountModal companyId={activeCompany.id}
          onClose={() => setShowAddAccount(false)}
          onCreated={() => { setShowAddAccount(false); loadAccounts(); }} />
      )}

      {showUpload && selectedId && (
        <UploadModal accountId={selectedId} accountName={selectedAccount?.nombre ?? ""}
          onClose={() => setShowUpload(false)}
          onImported={() => { setShowUpload(false); loadAccounts(); loadTxs(); }} />
      )}

      {showBulkMatch && activeCompany && (
        <BulkMatchModal
          companyId={activeCompany.id}
          selectionCount={selectionCount}
          selectionSum={selectionSum}
          onClose={() => setShowBulkMatch(false)}
          onConfirm={handleBulkMatch}
        />
      )}
    </div>
  );
}

// ── AccountCard ───────────────────────────────────────────────────────────────
function AccountCard({ account, selected, onSelect }: {
  account: BankAccount; selected: boolean; onSelect: () => void;
}) {
  return (
    <button onClick={onSelect}
      className={`text-left px-4 py-3 rounded-xl border transition-all ${
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border bg-white hover:border-primary/40 hover:bg-gray-50"
      }`}>
      <p className="font-semibold text-sm">{account.banco}</p>
      <p className="text-xs text-muted-foreground">{account.nombre} ••••{account.numeroCuenta.slice(-4)}</p>
      {account.lastTransaction?.saldo != null && (
        <p className="text-sm font-bold mt-1">{formatCurrency(account.lastTransaction.saldo)}</p>
      )}
      {account.stats.unmatched > 0 && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">
          {account.stats.unmatched} por conciliar
        </span>
      )}
    </button>
  );
}

// ── Shared row pieces (used by both the desktop table and the mobile cards) ────
interface RowActionProps {
  tx: BankTx; expanded: boolean;
  onExpand: () => void; onIgnore: () => void;
  onUnmatch: () => void; onUnignore: () => void;
}

/** The "↳ Factura/Gasto/Reembolso/Raya" lines shown under a matched movement. */
function MatchedLinks({ tx }: { tx: BankTx }) {
  if (tx.status !== "MATCHED") return null;
  return (
    <>
      {tx.invoice && (
        <p className="text-xs text-green-700 mt-0.5">
          ↳ {tx.invoice.customer?.razonSocial ?? "Factura"} · {formatCurrency(tx.invoice.total)}
        </p>
      )}
      {tx.gastoPagado && (
        <p className="text-xs text-green-700 mt-0.5">
          ↳ Gasto: {tx.gastoPagado.beneficiarioNombre} ·
          {tx.gastoPagado.proyecto?.codigo ? ` ${tx.gastoPagado.proyecto.codigo} ·` : ""}
          {" "}{formatCurrency(tx.gastoPagado.importe)}
        </p>
      )}
      {tx.reembolsoPagado && (
        <p className="text-xs text-green-700 mt-0.5">
          ↳ Reembolso semanal{tx.reembolsoPagado.proyecto?.codigo ? ` · ${tx.reembolsoPagado.proyecto.codigo}` : ""} · {formatCurrency(tx.reembolsoPagado.totalReembolso)}
        </p>
      )}
      {tx.rayaPagada && (
        <p className="text-xs text-green-700 mt-0.5">
          ↳ Raya: {tx.rayaPagada.cuadrilla?.nombre ?? "destajo"}
          {tx.rayaPagada.proyecto?.codigo ? ` · ${tx.rayaPagada.proyecto.codigo}` : ""} · {formatCurrency(tx.rayaPagada.totalDestajo)}
        </p>
      )}
    </>
  );
}

/** Estado pill: Sin conciliar / Conciliado / category tag / Ignorado. */
function StatusBadge({ tx }: { tx: BankTx }) {
  if (tx.status === "UNMATCHED") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
        <AlertCircle className="h-3 w-3" />Sin conciliar
      </span>
    );
  }
  if (tx.status === "MATCHED") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
        <CheckCircle2 className="h-3 w-3" />Conciliado
      </span>
    );
  }
  // IGNORED — may carry a category tag in notes.
  const map: Record<string, { label: string; cls: string }> = {
    PENDING_MONTHLY_CFDI: { label: "Pendiente CFDI", cls: "text-blue-700 bg-blue-50" },
    TAX_PAYMENT:          { label: "Impuestos",      cls: "text-purple-700 bg-purple-50" },
    PAYROLL_NO_CFDI:      { label: "Nómina",         cls: "text-indigo-700 bg-indigo-50" },
    LOAN_RECEIVED:        { label: "Préstamo",       cls: "text-pink-700 bg-pink-50" },
    LOAN_GIVEN:           { label: "Préstamo otorg.",cls: "text-pink-700 bg-pink-50" },
    CAPITAL_CONTRIBUTION: { label: "Capital",        cls: "text-emerald-700 bg-emerald-50" },
    INTERNAL_TRANSFER:    { label: "Transferencia",  cls: "text-cyan-700 bg-cyan-50" },
    NON_DEDUCTIBLE:       { label: "No deducible",   cls: "text-orange-700 bg-orange-50" },
  };
  const m = map[tx.notes ?? ""];
  return m ? (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
      <X className="h-3 w-3" />Ignorado
    </span>
  );
}

/** Per-movement action buttons (conciliar / ignorar / desconectar / etc.). */
function RowActions({ tx, expanded, onExpand, onIgnore, onUnmatch, onUnignore }: RowActionProps) {
  return (
    <div className="flex items-center gap-1 justify-end">
      {tx.status === "UNMATCHED" && (
        <>
          <button onClick={onExpand} title={expanded ? "Cerrar" : "Conciliar"}
            className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
            <LinkIcon className="h-3.5 w-3.5" />
          </button>
          <button onClick={onIgnore} title="Ignorar"
            className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {tx.status === "MATCHED" && (
        <button onClick={onUnmatch} title="Desconectar"
          className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
          <Unlink className="h-3.5 w-3.5" />
        </button>
      )}
      {tx.status === "IGNORED" && (
        <>
          <button onClick={onExpand} title="Re-categorizar / conciliar"
            className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
            <LinkIcon className="h-3.5 w-3.5" />
          </button>
          <button onClick={onUnignore} title="Mover a sin conciliar"
            className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

interface TxItemProps extends RowActionProps {
  acting: boolean; selected: boolean; onToggleSelect: () => void;
}

// ── TxRow (desktop table) ──────────────────────────────────────────────────────
function TxRow({ tx, expanded, acting, selected, onToggleSelect, onExpand, onIgnore, onUnmatch, onUnignore }: TxItemProps) {
  const isCredit = tx.monto > 0;
  return (
    <tr className={`border-b border-border last:border-0 ${acting ? "opacity-50" : ""} ${selected ? "bg-blue-50" : expanded ? "bg-blue-50/40" : "hover:bg-gray-50/50"}`}>
      <td className="px-3 py-3 w-8">
        <input type="checkbox" checked={selected} onChange={onToggleSelect}
          className="h-3.5 w-3.5 rounded border-border cursor-pointer" />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDate(tx.fecha)}</td>
      <td className="px-4 py-3 max-w-[280px]">
        <p className="text-xs font-medium truncate">{tx.descripcion}</p>
        {tx.referencia && <p className="text-xs text-muted-foreground">Ref: {tx.referencia}</p>}
        <MatchedLinks tx={tx} />
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <span className={`text-sm font-semibold flex items-center justify-end gap-1 ${isCredit ? "text-green-700" : "text-red-600"}`}>
          {isCredit ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
          {formatCurrency(Math.abs(tx.monto))}
        </span>
      </td>
      <td className="px-4 py-3 text-right text-xs text-muted-foreground whitespace-nowrap">
        {tx.saldo != null ? formatCurrency(tx.saldo) : "—"}
      </td>
      <td className="px-4 py-3"><StatusBadge tx={tx} /></td>
      <td className="px-4 py-3">
        {acting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-auto" />
          : <RowActions tx={tx} expanded={expanded} onExpand={onExpand} onIgnore={onIgnore} onUnmatch={onUnmatch} onUnignore={onUnignore} />}
      </td>
    </tr>
  );
}

// ── TxCard (mobile) ────────────────────────────────────────────────────────────
// Same data as TxRow, laid out vertically so the monto is always visible and the
// description can wrap instead of being clipped off-screen.
function TxCard({ tx, expanded, acting, selected, onToggleSelect, onExpand, onIgnore, onUnmatch, onUnignore }: TxItemProps) {
  const isCredit = tx.monto > 0;
  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${acting ? "opacity-50" : ""} ${selected ? "bg-blue-50" : expanded ? "bg-blue-50/40" : ""}`}>
      <input type="checkbox" checked={selected} onChange={onToggleSelect}
        className="mt-1 h-4 w-4 rounded border-border cursor-pointer shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(tx.fecha)}</span>
          <span className={`text-sm font-semibold flex items-center gap-1 shrink-0 ${isCredit ? "text-green-700" : "text-red-600"}`}>
            {isCredit ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
            {formatCurrency(Math.abs(tx.monto))}
          </span>
        </div>
        <p className="text-sm font-medium mt-0.5 line-clamp-2 break-words">{tx.descripcion}</p>
        {tx.referencia && <p className="text-xs text-muted-foreground">Ref: {tx.referencia}</p>}
        {tx.saldo != null && <p className="text-xs text-muted-foreground">Saldo: {formatCurrency(tx.saldo)}</p>}
        <MatchedLinks tx={tx} />
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <StatusBadge tx={tx} />
          {acting
            ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            : <RowActions tx={tx} expanded={expanded} onExpand={onExpand} onIgnore={onIgnore} onUnmatch={onUnmatch} onUnignore={onUnignore} />}
        </div>
      </div>
    </div>
  );
}

// ── MatchPanel ────────────────────────────────────────────────────────────────
function MatchPanel({ tx, candidates, loading, onMatch, onIgnore, onCategorize, onClose }: {
  tx: BankTx; candidates: Candidate[]; loading: boolean;
  onMatch: (id: string) => void;
  onIgnore: () => void;
  onCategorize: (notesTag: string) => void;
  onClose: () => void;
}) {
  const isCredit = tx.monto > 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-blue-800">
          Conciliar {isCredit ? "cobro" : "pago"} de {formatCurrency(Math.abs(tx.monto))} del {formatDate(tx.fecha)}
        </p>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />Buscando facturas candidatas...
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">
          No se encontraron facturas {isCredit ? "de ingreso" : "de egreso"} con montos similares en ±30 días.
        </p>
      ) : (
        <div className="space-y-1.5 mb-2">
          {candidates.map(c => {
            const isPue = c.metodoPago === "PUE";
            const fullyMatched = c.alreadyMatched && isPue;
            const partiallyMatched = c.alreadyMatched && !isPue && (c.remainingBalance ?? 0) > 0.01;
            return (
              <button
                key={c.id}
                onClick={() => !fullyMatched && onMatch(c.id)}
                disabled={fullyMatched}
                className={`w-full flex items-center gap-3 text-left border rounded-lg px-3 py-2 transition-colors group ${
                  fullyMatched
                    ? "bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed"
                    : partiallyMatched
                      ? "bg-amber-50 border-amber-300 hover:border-amber-400"
                      : "bg-white border-border hover:border-primary hover:bg-primary/5"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium truncate">{c.cliente}</p>
                    {c.metodoPago && (
                      <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-gray-100 text-gray-600">{c.metodoPago}</span>
                    )}
                    {c.alreadyMatched && (
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                        fullyMatched ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                      }`}>
                        {fullyMatched ? "Ya conciliada" : "Parcial"}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(c.fecha)} · {c.rfc}
                    {c.serie || c.folio ? ` · ${c.serie ?? ""}${c.folio ?? ""}` : ""}
                  </p>
                  {partiallyMatched && (
                    <p className="text-[10px] text-amber-700 mt-0.5">
                      Ya cobrado: {formatCurrency(c.matchedAmount ?? 0)} · Falta: {formatCurrency(c.remainingBalance ?? 0)}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-semibold">{formatCurrency(c.total)}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CONFIDENCE_COLORS[c.confidence]}`}>
                    {c.confidence}
                  </span>
                </div>
                {!fullyMatched && <LinkIcon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-blue-200/60">
        <p className="text-xs text-muted-foreground mb-1.5">O categoriza sin factura:</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <CategoryChip label="🏛️ Pago de impuestos" onClick={() => onCategorize("TAX_PAYMENT")} />
          <CategoryChip label="👥 Nómina sin CFDI" onClick={() => onCategorize("PAYROLL_NO_CFDI")} />
          <CategoryChip label="💸 Préstamo recibido" onClick={() => onCategorize("LOAN_RECEIVED")} />
          <CategoryChip label="🤝 Préstamo otorgado" onClick={() => onCategorize("LOAN_GIVEN")} />
          <CategoryChip label="🏦 Aportación de capital" onClick={() => onCategorize("CAPITAL_CONTRIBUTION")} />
          <CategoryChip label="🚫 No deducible" onClick={() => onCategorize("NON_DEDUCTIBLE")} />
          <CategoryChip label="↔️ Transferencia entre cuentas" onClick={() => onCategorize("INTERNAL_TRANSFER")} />
          <CategoryChip label="✕ Ignorar" onClick={onIgnore} />
        </div>
      </div>
    </div>
  );
}

function CategoryChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-2.5 py-1 rounded-full bg-white border border-border hover:border-primary hover:bg-primary/5 hover:text-primary transition-colors"
    >
      {label}
    </button>
  );
}

// ── AddAccountModal ───────────────────────────────────────────────────────────
function AddAccountModal({ companyId, onClose, onCreated }: {
  companyId: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({ banco: "BBVA", nombre: "", numeroCuenta: "", clabe: "", moneda: "MXN" });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/bancos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, ...form }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      onCreated();
    } catch (e) { setErr(e instanceof Error ? e.message : "Error"); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold">Agregar cuenta bancaria</h2>
          <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
        </div>
        {err && <p className="text-sm text-red-600 mb-3">{err}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Banco</label>
            <select value={form.banco} onChange={e => setForm(f => ({ ...f, banco: e.target.value }))}
              className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
              {BANKS.map(b => <option key={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Nombre de la cuenta</label>
            <input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Ej. Cuenta Eje Empresarial" required
              className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Número de cuenta</label>
            <input value={form.numeroCuenta} onChange={e => setForm(f => ({ ...f, numeroCuenta: e.target.value }))}
              placeholder="0123456789" required
              className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">CLABE (opcional)</label>
            <input value={form.clabe} onChange={e => setForm(f => ({ ...f, clabe: e.target.value }))}
              placeholder="18 dígitos"
              className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-border rounded-md py-2 text-sm hover:bg-accent transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors">
              {saving ? "Guardando..." : "Agregar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── UploadModal ───────────────────────────────────────────────────────────────
function UploadModal({ accountId, accountName, onClose, onImported }: {
  accountId: string; accountName: string; onClose: () => void; onImported: () => void;
}) {
  const [file, setFile]           = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult]       = useState<string | null>(null);
  const [err, setErr]             = useState("");

  async function handleUpload() {
    if (!file) return;
    setUploading(true); setErr(""); setResult(null);
    try {
      // Read raw bytes so we can fall back to windows-1252 if UTF-8 fails.
      // Mexican bank exports (Bajío, Banamex) are often Latin-1.
      const buf = await file.arrayBuffer();
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      if (text.includes("\uFFFD")) {
        text = new TextDecoder("windows-1252").decode(buf);
      }
      // Excel (.xlsx/.xls/.xlsm) es binario → base64 (el server lo convierte a CSV);
      // CSV/TXT/OFX van como texto, con el fallback a windows-1252 de arriba.
      const esExcel = /\.(xlsx|xls|xlsm)$/i.test(file.name);
      let fileContent = text;
      if (esExcel) {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        fileContent = btoa(bin);
      }
      const res  = await fetch(`/api/bancos/${accountId}/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileContent, filename: file.name, encoding: esExcel ? "base64" : "text" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al importar");
      setResult(data.message);
      setTimeout(() => onImported(), 1500);
    } catch (e) { setErr(e instanceof Error ? e.message : "Error"); }
    finally { setUploading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-semibold">Cargar estado de cuenta</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{accountName}</p>
          </div>
          <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
        </div>

        {err && <p className="text-sm text-red-600 mb-3">{err}</p>}
        {result && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700 mb-3">
            <CheckCircle2 className="h-4 w-4 shrink-0" />{result}
          </div>
        )}

        <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          file ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-gray-50"
        }`}>
          <Upload className="h-6 w-6 text-muted-foreground mb-2" />
          <p className="text-sm font-medium">{file ? file.name : "Selecciona un archivo"}</p>
          <p className="text-xs text-muted-foreground mt-0.5">CSV, TXT, XLS (BBVA RSM) u OFX/QFX — todos los bancos</p>
          <input type="file" accept=".csv,.txt,.ofx,.qfx,.xls,.xlsx,.xlsm,.xml" className="hidden"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setErr(""); setResult(null); }} />
        </label>

        <div className="flex items-start gap-2 mt-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Exporta el estado de cuenta desde tu banca en línea. El sistema detecta automáticamente el formato de BBVA, Banamex, Santander, Banorte y otros.
        </div>

        <div className="flex gap-3 mt-4">
          <button onClick={onClose}
            className="flex-1 border border-border rounded-md py-2 text-sm hover:bg-accent transition-colors">
            Cancelar
          </button>
          <button onClick={handleUpload} disabled={!file || uploading || !!result}
            className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors flex items-center justify-center gap-2">
            {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? "Importando..." : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── BulkMatchModal — N-to-1 factura picker ───────────────────────────────────
interface FacturaSearchResult {
  id: string;
  uuid: string | null;
  folio: string | null;
  serie: string | null;
  fecha: string;
  total: number;
  tipo: string;
  customer: { razonSocial: string; rfc: string } | null;
  matchedAmount: number;
  fullyMatched: boolean;
}

function BulkMatchModal({
  companyId,
  selectionCount,
  selectionSum,
  onClose,
  onConfirm,
}: {
  companyId: string;
  selectionCount: number;
  selectionSum: number;
  onClose: () => void;
  onConfirm: (invoiceId: string) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [tipo, setTipo] = useState<"EGRESO" | "INGRESO" | "NOMINA">("EGRESO");
  const [unmatchedOnly, setUnmatchedOnly] = useState(true);
  const [results, setResults] = useState<FacturaSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<FacturaSearchResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Debounced search
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ companyId, tipo, take: "30" });
        if (query.trim()) params.set("q", query.trim());
        if (unmatchedOnly) params.set("unmatchedOnly", "true");
        const res = await fetch(`/api/facturas?${params}`);
        const data = await res.json();
        if (!cancelled) setResults(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, tipo, companyId, unmatchedOnly]);

  async function confirm() {
    if (!picked) return;
    setConfirming(true);
    try {
      await onConfirm(picked.id);
    } finally {
      setConfirming(false);
    }
  }

  const totalAfter = picked ? picked.matchedAmount + selectionSum : 0;
  const coverage = picked ? Math.round((totalAfter / picked.total) * 100) : 0;
  const exceeds = picked && totalAfter > picked.total * 1.001;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-16 p-4 z-50">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Conciliar {selectionCount} movimiento(s) con una factura</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Suma seleccionada: <strong>{formatCurrency(selectionSum)}</strong>
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter + search */}
        <div className="px-5 py-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setTipo("EGRESO")}
              className={`text-xs px-2.5 py-1 rounded-full ${tipo === "EGRESO" ? "bg-primary text-primary-foreground" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              Gastos (Egreso)
            </button>
            <button
              onClick={() => setTipo("INGRESO")}
              className={`text-xs px-2.5 py-1 rounded-full ${tipo === "INGRESO" ? "bg-primary text-primary-foreground" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              Ingresos
            </button>
            <button
              onClick={() => setTipo("NOMINA")}
              className={`text-xs px-2.5 py-1 rounded-full ${tipo === "NOMINA" ? "bg-primary text-primary-foreground" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              Nómina
            </button>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={unmatchedOnly}
                onChange={(e) => setUnmatchedOnly(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Solo facturas por conciliar
            </label>
          </div>
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por proveedor, RFC, UUID, folio…"
              className="w-full pl-9 pr-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Buscando facturas…
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              Sin resultados. Prueba otro término o tipo de factura.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((f) => {
                const isPicked = picked?.id === f.id;
                return (
                  <li key={f.id}>
                    <button
                      onClick={() => setPicked(f)}
                      className={`w-full text-left px-5 py-3 flex items-start gap-3 hover:bg-gray-50 ${isPicked ? "bg-blue-50" : ""}`}
                    >
                      <input
                        type="radio"
                        checked={isPicked}
                        readOnly
                        className="mt-1 h-3.5 w-3.5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {f.customer?.razonSocial ?? "Sin cliente"}{" "}
                          <span className="text-xs text-muted-foreground font-normal">{f.customer?.rfc ?? ""}</span>
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {formatDate(f.fecha)}{" "}
                          {f.folio ? `· Folio ${f.serie ?? ""}${f.folio}` : ""}{" "}
                          {f.uuid ? `· ${f.uuid.slice(0, 8)}…` : ""}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold">{formatCurrency(f.total)}</p>
                        {f.matchedAmount > 0.01 && (
                          <p className="text-xs text-amber-700">
                            Ya conciliado: {formatCurrency(f.matchedAmount)}
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer with preview + confirm */}
        <div className="px-5 py-4 border-t border-border bg-gray-50 space-y-3">
          {picked && (
            <div className="text-xs bg-white border border-border rounded-md p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Factura total</span>
                <strong>{formatCurrency(picked.total)}</strong>
              </div>
              {picked.matchedAmount > 0.01 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Ya conciliado</span>
                  <strong>{formatCurrency(picked.matchedAmount)}</strong>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">+ Esta selección</span>
                <strong>{formatCurrency(selectionSum)}</strong>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-border">
                <span className="text-muted-foreground">Cobertura total</span>
                <strong className={exceeds ? "text-red-600" : coverage >= 99 ? "text-green-700" : "text-amber-700"}>
                  {coverage}% {exceeds ? "(excede)" : coverage < 99 ? "(parcial)" : "(completa)"}
                </strong>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 border border-border rounded-md py-2 text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              onClick={confirm}
              disabled={!picked || confirming}
              className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 hover:bg-primary/90 flex items-center justify-center gap-2"
            >
              {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
              Conciliar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
