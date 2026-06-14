"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Save, CheckCircle2, AlertTriangle, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card } from "@/components/ui";

interface Cuenta {
  codigo: string;
  nombre: string;
  nivel: number;
  tipo: string;
  naturaleza: "D" | "A";
  saldo: number;
}

const fmtMxn = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

export default function AperturaPage() {
  const { activeCompany } = useCompany();
  const [cuentas, setCuentas] = useState<Cuenta[] | null>(null);
  const [fecha, setFecha] = useState("");
  const [saldos, setSaldos] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setCuentas(null);
    const res = await fetch(`/api/contabilidad/apertura?companyId=${activeCompany.id}`);
    if (!res.ok) {
      setMsg({ tone: "err", text: "No se pudieron cargar las cuentas." });
      setCuentas([]);
      return;
    }
    const data = await res.json();
    setCuentas(data.cuentas ?? []);
    setFecha(data.fecha ?? new Date().toISOString().slice(0, 10));
    const init: Record<string, string> = {};
    for (const c of data.cuentas ?? []) if (c.saldo) init[c.codigo] = String(c.saldo);
    setSaldos(init);
  }, [activeCompany]);

  useEffect(() => {
    load();
  }, [load]);

  const { cargos, abonos, diferencia, balanceado, conSaldo } = useMemo(() => {
    let cargos = 0;
    let abonos = 0;
    let conSaldo = 0;
    for (const c of cuentas ?? []) {
      const v = Number(saldos[c.codigo]);
      if (!Number.isFinite(v) || Math.abs(v) < 0.005) continue;
      conSaldo++;
      const esCargo = (c.naturaleza === "D") === (v >= 0);
      if (esCargo) cargos += Math.abs(v);
      else abonos += Math.abs(v);
    }
    cargos = Math.round(cargos * 100) / 100;
    abonos = Math.round(abonos * 100) / 100;
    const diferencia = Math.round((cargos - abonos) * 100) / 100;
    return { cargos, abonos, diferencia, balanceado: Math.abs(diferencia) < 0.01, conSaldo };
  }, [cuentas, saldos]);

  async function guardar() {
    if (!activeCompany) return;
    setSaving(true);
    setMsg(null);
    try {
      const lineas = (cuentas ?? [])
        .map((c) => ({ codigo: c.codigo, saldo: Number(saldos[c.codigo]) }))
        .filter((l) => Number.isFinite(l.saldo) && Math.abs(l.saldo) >= 0.005);
      const res = await fetch("/api/contabilidad/apertura", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, fecha, lineas }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar");
      setMsg({ tone: "ok", text: `Saldos iniciales guardados (${data.entries} cuentas, ${fmtMxn(data.totalCargos)}).` });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Error al guardar" });
    } finally {
      setSaving(false);
    }
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa para capturar sus saldos iniciales.</div>;
  }

  return (
    <div className="mx-auto max-w-[920px] px-4 py-6 sm:px-8 sm:py-8">
      <Link href="/contabilidad" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-soft hover:text-cos-ink">
        <ChevronLeft className="h-4 w-4" /> Contabilidad
      </Link>
      <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.03em] text-cos-ink">Saldos iniciales</h1>
      <p className="mt-1 max-w-[64ch] text-[15px] text-cos-ink-soft">
        Asiento de apertura para empresas que migran a media vida. Captura el saldo de cada cuenta en su signo
        natural (deudora = saldo positivo a cargo; acreedora = positivo a abono). Debe cuadrar: <strong>cargos = abonos</strong>.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <label className="text-[13px] font-medium text-cos-ink-soft">Fecha del asiento</label>
        <input
          type="date"
          value={fecha}
          onChange={(e) => setFecha(e.target.value)}
          className="rounded-control border border-cos-line px-2.5 py-1.5 text-sm outline-none focus:border-cos-brand-ink"
        />
      </div>

      {msg && (
        <div className={`mt-4 flex items-center gap-2 rounded-control px-4 py-3 text-sm ${msg.tone === "ok" ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-red-tint text-cos-red-ink"}`}>
          {msg.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          {msg.text}
        </div>
      )}

      {cuentas === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando catálogo…
        </div>
      ) : (
        <Card className="mt-5 overflow-hidden rounded-card border-cos-line shadow-card">
          <div className="grid grid-cols-[1fr_64px_150px] gap-2 border-b border-cos-line px-4 py-2 text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
            <span>Cuenta</span>
            <span className="text-center">Nat.</span>
            <span className="text-right">Saldo inicial</span>
          </div>
          <div className="max-h-[52vh] divide-y divide-cos-line overflow-auto">
            {cuentas.map((c) => (
              <div key={c.codigo} className="grid grid-cols-[1fr_64px_150px] items-center gap-2 px-4 py-2">
                <div className="min-w-0">
                  <span className="font-mono text-[12px] text-cos-ink-faint">{c.codigo}</span>{" "}
                  <span className="text-[13.5px] text-cos-ink">{c.nombre}</span>
                </div>
                <span className="text-center text-[12px] text-cos-ink-soft">{c.naturaleza}</span>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={saldos[c.codigo] ?? ""}
                  onChange={(e) => setSaldos((s) => ({ ...s, [c.codigo]: e.target.value }))}
                  placeholder="0.00"
                  className="w-full rounded-control border border-cos-line px-2 py-1 text-right text-[13.5px] outline-none focus:border-cos-brand-ink"
                />
              </div>
            ))}
          </div>

          {/* Sticky-ish footer with running totals */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cos-line bg-cos-paper px-4 py-3">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
              <span className="text-cos-ink-soft">Cargos: <b className="text-cos-ink">{fmtMxn(cargos)}</b></span>
              <span className="text-cos-ink-soft">Abonos: <b className="text-cos-ink">{fmtMxn(abonos)}</b></span>
              <span className={balanceado ? "text-cos-jade-ink" : "text-cos-red-ink"}>
                {balanceado ? "✓ Cuadra" : `Diferencia: ${fmtMxn(diferencia)}`}
              </span>
            </div>
            <button
              onClick={guardar}
              disabled={saving || conSaldo === 0 || !balanceado}
              title={!balanceado ? "El asiento debe cuadrar (cargos = abonos)" : undefined}
              className="inline-flex items-center gap-1.5 rounded-control border border-transparent bg-cos-jade px-4 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar saldos iniciales
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
