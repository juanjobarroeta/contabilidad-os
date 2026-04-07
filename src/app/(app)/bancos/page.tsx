"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Upload, Zap, ChevronDown,
  CheckCircle2, AlertCircle, Loader2, X,
  ArrowDownLeft, ArrowUpRight, Landmark,
  Link as LinkIcon, Unlink, Search, Clock,
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
}
interface Candidate {
  id: string; uuid?: string | null; fecha: string; total: number;
  cliente: string; rfc: string; score: number;
  confidence: "alta" | "media" | "baja";
}

type TxFilter = "all" | "UNMATCHED" | "MATCHED" | "IGNORED" | "PENDING";

type StatusCounts = {
  UNMATCHED: number; MATCHED: number; IGNORED: number; PENDING: number; total: number;
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
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({ UNMATCHED: 0, MATCHED: 0, IGNORED: 0, PENDING: 0, total: 0 });
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
      setStatusCounts(data.statusCounts ?? { UNMATCHED: 0, MATCHED: 0, IGNORED: 0, PENDING: 0, total: 0 });
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
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Bancos y Conciliación</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <button onClick={() => setShowAddAccount(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors">
          <Plus className="h-4 w-4" />Agregar cuenta
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
              <div className="px-5 py-4 border-b border-border flex flex-wrap items-center gap-3">
                <div>
                  <h2 className="font-semibold text-sm">{selectedAccount.banco} — {selectedAccount.nombre}</h2>
                  <p className="text-xs text-muted-foreground">••••{selectedAccount.numeroCuenta.slice(-4)}</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => setShowUpload(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-md text-xs font-medium hover:bg-accent transition-colors">
                    <Upload className="h-3.5 w-3.5" />Cargar estado de cuenta
                  </button>
                  <button onClick={handleAutoMatch} disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    Conciliar automáticamente
                  </button>
                </div>
              </div>

              {/* Filter tabs */}
              <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
                {([
                  ["all",       "Todos",              statusCounts.total],
                  ["UNMATCHED", "Sin conciliar",      statusCounts.UNMATCHED],
                  ["PENDING",   "Pendiente CFDI mensual", statusCounts.PENDING],
                  ["MATCHED",   "Conciliados",        statusCounts.MATCHED],
                  ["IGNORED",   "Ignorados",          statusCounts.IGNORED],
                ] as const).map(([f, label, count]) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
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
                <div className="px-5 py-3 bg-blue-50 border-b border-blue-200 flex items-center justify-between gap-3 flex-wrap">
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
                  <table className="w-full text-sm">
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
                        <>
                          <TxRow key={tx.id} tx={tx}
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
                            <tr key={`${tx.id}-panel`}>
                              <td colSpan={7} className="bg-blue-50/60 border-b border-border px-5 pb-4 pt-2">
                                <MatchPanel
                                  tx={tx}
                                  candidates={candidates}
                                  loading={candidatesLoading}
                                  onMatch={(id) => applyAction(tx.id, "match", id)}
                                  onIgnore={() => applyAction(tx.id, "ignore")}
                                  onClose={() => setExpandedTxId(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>

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

// ── TxRow ─────────────────────────────────────────────────────────────────────
function TxRow({ tx, expanded, acting, selected, onToggleSelect, onExpand, onIgnore, onUnmatch, onUnignore }: {
  tx: BankTx; expanded: boolean; acting: boolean; selected: boolean;
  onToggleSelect: () => void;
  onExpand: () => void; onIgnore: () => void;
  onUnmatch: () => void; onUnignore: () => void;
}) {
  const isCredit = tx.monto > 0;
  return (
    <tr className={`border-b border-border last:border-0 ${acting ? "opacity-50" : ""} ${selected ? "bg-blue-50" : expanded ? "bg-blue-50/40" : "hover:bg-gray-50/50"}`}>
      <td className="px-3 py-3 w-8">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 rounded border-border cursor-pointer"
        />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(tx.fecha)}
      </td>
      <td className="px-4 py-3 max-w-[280px]">
        <p className="text-xs font-medium truncate">{tx.descripcion}</p>
        {tx.referencia && <p className="text-xs text-muted-foreground">Ref: {tx.referencia}</p>}
        {tx.status === "MATCHED" && tx.invoice && (
          <p className="text-xs text-green-700 mt-0.5">
            ↳ {tx.invoice.customer?.razonSocial ?? "Factura"} · {formatCurrency(tx.invoice.total)}
          </p>
        )}
        {tx.status === "IGNORED" && tx.notes && (
          <p className="text-xs text-gray-400 mt-0.5">Ignorado: {tx.notes}</p>
        )}
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
      <td className="px-4 py-3">
        {tx.status === "UNMATCHED" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
            <AlertCircle className="h-3 w-3" />Sin conciliar
          </span>
        )}
        {tx.status === "MATCHED" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
            <CheckCircle2 className="h-3 w-3" />Conciliado
          </span>
        )}
        {tx.status === "IGNORED" && tx.notes === "PENDING_MONTHLY_CFDI" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
            <Clock className="h-3 w-3" />Pendiente CFDI
          </span>
        )}
        {tx.status === "IGNORED" && tx.notes !== "PENDING_MONTHLY_CFDI" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
            <X className="h-3 w-3" />Ignorado
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {acting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-auto" />
          : (
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
              <button onClick={onUnignore} title="Reactivar"
                className="p-1.5 rounded hover:bg-gray-200 text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

// ── MatchPanel ────────────────────────────────────────────────────────────────
function MatchPanel({ tx, candidates, loading, onMatch, onIgnore, onClose }: {
  tx: BankTx; candidates: Candidate[]; loading: boolean;
  onMatch: (id: string) => void; onIgnore: () => void; onClose: () => void;
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
          {candidates.map(c => (
            <button key={c.id} onClick={() => onMatch(c.id)}
              className="w-full flex items-center gap-3 text-left bg-white border border-border rounded-lg px-3 py-2 hover:border-primary hover:bg-primary/5 transition-colors group">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{c.cliente}</p>
                <p className="text-xs text-muted-foreground">{formatDate(c.fecha)} · {c.rfc}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-semibold">{formatCurrency(c.total)}</p>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CONFIDENCE_COLORS[c.confidence]}`}>
                  {c.confidence}
                </span>
              </div>
              <LinkIcon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
            </button>
          ))}
        </div>
      )}

      <button onClick={onIgnore}
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors mt-1">
        Ignorar (nómina, impuestos, gastos sin factura)
      </button>
    </div>
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
      const res  = await fetch(`/api/bancos/${accountId}/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileContent: text, filename: file.name }),
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
          <p className="text-xs text-muted-foreground mt-0.5">CSV, TXT u OFX/QFX — todos los bancos</p>
          <input type="file" accept=".csv,.txt,.ofx,.qfx" className="hidden"
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
  const [tipo, setTipo] = useState<"EGRESO" | "INGRESO">("EGRESO");
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
