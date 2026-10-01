"use client";
import { useEffect, useRef, useState } from "react";
import { Paperclip, Loader2, X } from "lucide-react";
export type UploadedBankDocument = { batchId: string; bankAccountId: string; month: string; message: string };
export function BankDocumentUpload({ companyId, month: initialMonth, disabled, onUploaded }: {
  companyId: string; month: string; disabled?: boolean; onUploaded: (document: UploadedBankDocument) => void;
}) {
  const [open, setOpen] = useState(false), [accounts, setAccounts] = useState<{ id: string; nombre: string; banco: string }[]>([]);
  const [accountId, setAccountId] = useState(""), [month, setMonth] = useState(initialMonth), [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState(""), [needsPassword, setNeedsPassword] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setMonth(initialMonth); }, [initialMonth]);
  useEffect(() => { if (!open) return; const controller = new AbortController();
    fetch(`/api/bancos?companyId=${encodeURIComponent(companyId)}`, { signal: controller.signal }).then(async (r) => {
      const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "No se pudieron consultar las cuentas.");
      if (!Array.isArray(body)) throw new Error("Respuesta de cuentas inválida.");
      setAccounts(body); setAccountId((current) => body.some((a) => a.id === current) ? current : body.length === 1 ? body[0].id : "");
    }).catch((e) => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [open, companyId]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  async function upload() {
    if (!file || !accountId || !month) return;
    if (file.size > 15 * 1024 * 1024) { setError("Máximo 15 MB por documento."); return; }
    setBusy(true); setError("");
    const form = new FormData(); form.set("companyId", companyId); form.set("bankAccountId", accountId); form.set("month", month); form.set("file", file);
    if (password) form.set("password", password);
    try {
      const response = await fetch("/api/ai/bank-documents", { method: "POST", body: form }); const data = await response.json();
      if (!alive.current) return;
      if (data.needsPassword) { setNeedsPassword(true); setError(data.error); return; }
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo leer el documento.");
      setOpen(false); setFile(null); setPassword(""); setNeedsPassword(false);
      onUploaded({ batchId: data.batchId, bankAccountId: accountId, month: /^\d{4}-\d{2}$/.test(data.periodo ?? "") ? data.periodo : month, message: data.message });
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "No se pudo subir el archivo."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <>
    <button type="button" disabled={disabled} title="Adjuntar estado bancario" aria-label="Adjuntar estado bancario" onClick={() => setOpen(true)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-cos-ink-soft hover:bg-cos-paper disabled:opacity-40"><Paperclip size={16} /></button>
    <dialog ref={dialog} onCancel={(e) => { if (busy) e.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)} className="m-auto w-[min(460px,92vw)] rounded-xl border border-cos-line bg-cos-card p-5 text-cos-ink shadow-xl backdrop:bg-black/40">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Adjuntar estado bancario</h2><button type="button" disabled={busy} aria-label="Cerrar" onClick={() => setOpen(false)}><X size={18} /></button></div>
      <p className="my-3 text-sm text-cos-ink-soft">CSV, Excel, OFX, PDF o imagen. Conservaremos el original y compararemos sus filas antes de contabilizar.</p>
      <label className="block text-sm">Cuenta<select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy} className="my-1 w-full rounded border border-cos-line bg-cos-canvas p-2"><option value="">Selecciona una cuenta</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.banco} · {a.nombre}</option>)}</select></label>
      <label className="block text-sm">Mes<input type="month" value={month} disabled={busy} onChange={(e) => setMonth(e.target.value)} className="my-1 w-full rounded border border-cos-line bg-cos-canvas p-2" /></label>
      <label className="my-3 block text-sm">Documento<input type="file" disabled={busy} accept=".csv,.txt,.ofx,.qfx,.xls,.xlsx,.pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setNeedsPassword(false); setPassword(""); }} className="mt-1 w-full" /></label>
      {needsPassword && <label className="block text-sm">Contraseña del PDF<input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="my-1 w-full rounded border border-cos-line bg-cos-canvas p-2" /></label>}
      {error && <p role="alert" className="my-2 text-sm text-red-600">{error}</p>}
      <button type="button" disabled={busy || !file || !accountId || !month} onClick={upload} className="mt-3 flex items-center gap-2 rounded-lg bg-cos-brand px-4 py-2 text-sm text-white disabled:opacity-40">{busy && <Loader2 size={15} className="animate-spin" />}{busy ? "Leyendo y comparando…" : "Subir y revisar"}</button>
    </dialog>
  </>;
}
