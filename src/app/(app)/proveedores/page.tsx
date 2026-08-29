"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Proveedores — espejo de la pestaña Clientes, pero para quienes NOS facturan.
//
// El catálogo se alimenta de dos maneras:
//   • "Importar de mis CFDIs": todo emisor de un CFDI recibido (EGRESO) se da
//     de alta con un clic — idempotente, sólo agrega los nuevos.
//   • Alta/edición manual, con los datos de pago SPEI (CLABE, banco, titular)
//     que los satélites (compras, construcción, automotriz) ya consumen.
// El RFC no se edita: es la identidad del proveedor por empresa.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { DirectorioNav } from "@/components/layout/DirectorioNav";
import { useState, useEffect, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import {
  Truck, Plus, Search, Pencil, Loader2, FileText, X, DownloadCloud, Landmark,
} from "lucide-react";
import {
  TableContainer, Table, THead, TBody, TR, TH, TD, Alert, RetryButton,
} from "@/components/ui";

const REGIMENES_FISCALES = [
  { value: "601", label: "601 – General de Ley Personas Morales" },
  { value: "603", label: "603 – Personas Morales con Fines no Lucrativos" },
  { value: "605", label: "605 – Sueldos y Salarios e Ingresos Asimilados" },
  { value: "606", label: "606 – Arrendamiento" },
  { value: "607", label: "607 – Enajenación o Adquisición de Bienes" },
  { value: "608", label: "608 – Demás ingresos" },
  { value: "612", label: "612 – Actividades Empresariales y Profesionales" },
  { value: "616", label: "616 – Sin obligaciones fiscales" },
  { value: "620", label: "620 – Sociedades Cooperativas de Producción" },
  { value: "621", label: "621 – Incorporación Fiscal" },
  { value: "622", label: "622 – Actividades Agrícolas, Ganaderas, Silvícolas" },
  { value: "625", label: "625 – Plataformas Tecnológicas" },
  { value: "626", label: "626 – RESICO" },
];

interface Proveedor {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string | null;
  email: string | null;
  clabe: string | null;
  banco: string | null;
  cuentaBancaria: string | null;
  titularCuenta: string | null;
  cfdisRecibidos: number;
  _count: { bankTransactions: number };
  /** "PRESUNTO" | "DEFINITIVO" sólo cuando el RFC aparece en la 69-B. */
  situacion69b?: string | null;
  /** Customer-emisor de sus EGRESO (abre su estado de cuenta), si existe. */
  emisorCustomerId?: string | null;
}

const EMPTY_FORM = {
  rfc: "", razonSocial: "", regimenFiscal: "",
  email: "", clabe: "", banco: "", cuentaBancaria: "", titularCuenta: "",
};

export default function ProveedoresPage() {
  const { activeCompany } = useCompany();
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Proveedor | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");

  const fetchProveedores = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setFetchError("");
    try {
      const res = await fetch(
        `/api/proveedores?companyId=${activeCompany.id}&search=${encodeURIComponent(search)}`
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      setProveedores(Array.isArray(data) ? data : []);
    } catch {
      // Error ≠ vacío: el estado "Sin proveedores aún" invita a re-importar de
      // CFDIs, y eso no debe nacer de un fetch fallido.
      setFetchError("No se pudieron cargar los proveedores.");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, search]);

  useEffect(() => { fetchProveedores(); }, [fetchProveedores]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 5000);
  }

  async function importarDeCfdis() {
    if (!activeCompany || importing) return;
    setImporting(true);
    try {
      const res = await fetch("/api/proveedores/import-cfdis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { showToast(data?.error ?? "No se pudo importar"); return; }
      showToast(
        data.creados > 0
          ? `✓ ${data.creados} proveedor${data.creados !== 1 ? "es" : ""} importado${data.creados !== 1 ? "s" : ""} de tus CFDIs`
          : "Todos los emisores de tus CFDIs ya estaban dados de alta"
      );
      fetchProveedores();
    } finally {
      setImporting(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError("");
    setShowModal(true);
  }

  function openEdit(p: Proveedor) {
    setEditing(p);
    setForm({
      rfc: p.rfc,
      razonSocial: p.razonSocial,
      regimenFiscal: p.regimenFiscal ?? "",
      email: p.email ?? "",
      clabe: p.clabe ?? "",
      banco: p.banco ?? "",
      cuentaBancaria: p.cuentaBancaria ?? "",
      titularCuenta: p.titularCuenta ?? "",
    });
    setError("");
    setShowModal(true);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: name === "rfc" ? value.toUpperCase() : value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activeCompany) return;
    setError("");
    setSaving(true);
    try {
      const url = editing ? `/api/proveedores/${editing.id}` : "/api/proveedores";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, companyId: activeCompany.id }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al guardar");
      }
      setShowModal(false);
      fetchProveedores();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSaving(false);
    }
  }

  const regimenLabel = (value: string | null) =>
    value ? REGIMENES_FISCALES.find((r) => r.value === value)?.label ?? value : "—";

  if (!activeCompany) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-[14px] text-cos-ink-faint">
        Selecciona una empresa para ver proveedores.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <DirectorioNav />
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Proveedores</h1>
          <p className="mt-1.5 text-[15px] text-cos-ink-soft">
            {activeCompany.razonSocial}
            {/* Con error no hay conteo que afirmar: "0 proveedores" sería falso. */}
            {!loading && !fetchError && ` · ${proveedores.length} proveedor${proveedores.length !== 1 ? "es" : ""}`}
          </p>
        </div>
        <div className="flex gap-2.5">
          <button
            onClick={importarDeCfdis}
            disabled={importing}
            title="Da de alta a todo emisor que te haya facturado (CFDIs recibidos). Repetirlo solo agrega los nuevos."
            className="inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[14px] font-medium text-cos-ink transition-colors hover:bg-cos-paper disabled:opacity-50"
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            {importing ? "Importando…" : "Importar de mis CFDIs"}
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-cos-brand-deep"
          >
            <Plus className="h-4 w-4" />
            Nuevo proveedor
          </button>
        </div>
      </div>

      {toast && (
        <div className="mt-4 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[13.5px] text-cos-ink">
          {toast}
        </div>
      )}

      {/* Search */}
      <div className="relative mt-5 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-cos-ink-faint" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por RFC o Razón Social…"
          className="w-full rounded-control border border-cos-line py-2 pl-9 pr-3 text-[14px] focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" />
          Cargando proveedores…
        </div>
      ) : fetchError ? (
        <Alert tone="danger" className="mt-5" action={<RetryButton onClick={fetchProveedores} />}>
          {fetchError}
        </Alert>
      ) : proveedores.length === 0 ? (
        <div className="mt-5 flex flex-col items-center justify-center rounded-card border border-dashed border-cos-line bg-cos-card py-16 text-center">
          <Truck className="mb-3 h-12 w-12 text-cos-ink-faint opacity-40" />
          <p className="text-[14px] font-semibold text-cos-ink">{search ? "Sin resultados" : "Sin proveedores aún"}</p>
          <p className="mt-1 max-w-[46ch] text-[13px] text-cos-ink-soft">
            {search
              ? "Intenta otro RFC o Razón Social"
              : "Impórtalos con un clic desde tus CFDIs recibidos — todo el que te haya facturado se da de alta solo."}
          </p>
          {!search && (
            <button
              onClick={importarDeCfdis}
              disabled={importing}
              className="mt-4 inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
              Importar de mis CFDIs
            </button>
          )}
        </div>
      ) : (
        <TableContainer className="mt-5 shadow-card">
          <Table>
            <THead>
              <TR>
                <TH>RFC</TH>
                <TH>Razón Social</TH>
                <TH className="hidden md:table-cell">Régimen</TH>
                <TH center className="hidden sm:table-cell">Facturas</TH>
                <TH center className="hidden sm:table-cell">Pagos</TH>
                <TH className="hidden lg:table-cell">Datos SPEI</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {proveedores.map((p) => (
                <TR
                  key={p.id}
                  onClick={() => openEdit(p)}
                  interactive
                >
                  <TD className="font-mono text-[12px] font-medium text-cos-ink">{p.rfc}</TD>
                  <TD className="font-medium text-cos-ink">
                    {p.emisorCustomerId ? (
                      <Link
                        href={`/clientes/${p.emisorCustomerId}/estado-cuenta?direccion=proveedor`}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        className="hover:text-cos-brand-ink hover:underline"
                        title="Ver estado de cuenta del proveedor"
                      >
                        {p.razonSocial}
                      </Link>
                    ) : (
                      p.razonSocial
                    )}
                    {p.situacion69b && (
                      <span
                        title={`Este RFC aparece en la lista 69-B del SAT (${p.situacion69b.toLowerCase()}): deducciones e IVA acreditable en riesgo`}
                        className={`ml-2 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                          p.situacion69b === "DEFINITIVO"
                            ? "bg-cos-red-tint text-cos-red-ink"
                            : "bg-cos-amber-tint text-cos-amber-ink"
                        }`}
                      >
                        69-B {p.situacion69b === "DEFINITIVO" ? "definitivo" : "presunto"}
                      </span>
                    )}
                  </TD>
                  <TD className="hidden md:table-cell">
                    {p.regimenFiscal ? (
                      <span
                        title={regimenLabel(p.regimenFiscal)}
                        className="inline-flex items-center gap-1 rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] text-cos-ink-soft"
                      >
                        {p.regimenFiscal}
                      </span>
                    ) : (
                      <span className="text-[12px] text-cos-ink-faint">—</span>
                    )}
                  </TD>
                  <TD center className="hidden sm:table-cell">
                    <span className="inline-flex items-center gap-1 text-[12px] text-cos-ink-soft">
                      <FileText className="h-3.5 w-3.5" />
                      {p.cfdisRecibidos}
                    </span>
                  </TD>
                  <TD center className="hidden text-[12px] text-cos-ink-soft sm:table-cell">
                    {p._count.bankTransactions}
                  </TD>
                  <TD className="hidden lg:table-cell">
                    {p.clabe || p.cuentaBancaria ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-cos-jade-tint px-2 py-0.5 text-[12px] font-medium text-cos-jade-ink">
                        <Landmark className="h-3 w-3" /> {p.clabe ? "CLABE" : "Cuenta"}
                      </span>
                    ) : (
                      <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] text-cos-ink-soft">
                        Sin capturar
                      </span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); openEdit(p); }}
                        className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-paper hover:text-cos-ink"
                        title="Editar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      )}

      {/* ── Create / Edit Modal ── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-cos-line">
              <h2 className="text-base font-semibold">
                {editing ? "Editar proveedor" : "Nuevo proveedor"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-control hover:bg-cos-paper text-cos-ink-faint"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  RFC <span className="text-red-500">*</span>
                </label>
                <input
                  type="text" name="rfc" value={form.rfc} onChange={handleChange}
                  placeholder="XAXX010101000" maxLength={13} required
                  disabled={!!editing}
                  className="w-full px-3 py-2 border border-cos-line rounded-control text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand uppercase disabled:bg-cos-paper disabled:text-cos-ink-faint"
                />
                {editing && (
                  <p className="text-xs text-cos-ink-soft mt-1">
                    El RFC es la identidad del proveedor — un RFC distinto es un alta nueva.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Razón Social <span className="text-red-500">*</span>
                </label>
                <input
                  type="text" name="razonSocial" value={form.razonSocial} onChange={handleChange}
                  placeholder="Proveedor SA de CV" required
                  className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Régimen Fiscal</label>
                  <select
                    name="regimenFiscal" value={form.regimenFiscal} onChange={handleChange}
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand bg-cos-card"
                  >
                    <option value="">Sin especificar</option>
                    {REGIMENES_FISCALES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">Correo electrónico</label>
                  <input
                    type="email" name="email" value={form.email} onChange={handleChange}
                    placeholder="proveedor@empresa.com"
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                  />
                </div>
              </div>

              {/* Datos de pago SPEI */}
              <div className="rounded-control border border-cos-line bg-cos-paper p-3.5">
                <p className="text-[13px] font-medium text-cos-ink">Datos de pago (SPEI)</p>
                <p className="mt-0.5 text-[12px] text-cos-ink-faint">
                  La CLABE (18 dígitos) es el dato canónico; banco y cuenta son auxiliares.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1.5">CLABE</label>
                    <input
                      type="text" name="clabe" value={form.clabe} onChange={handleChange}
                      placeholder="18 dígitos" maxLength={18} inputMode="numeric"
                      className="w-full px-3 py-2 border border-cos-line rounded-control text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5">Banco</label>
                    <input
                      type="text" name="banco" value={form.banco} onChange={handleChange}
                      placeholder="BBVA"
                      className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5">Cuenta bancaria</label>
                    <input
                      type="text" name="cuentaBancaria" value={form.cuentaBancaria} onChange={handleChange}
                      placeholder="Número de cuenta"
                      className="w-full px-3 py-2 border border-cos-line rounded-control text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1.5">Titular de la cuenta</label>
                    <input
                      type="text" name="titularCuenta" value={form.titularCuenta} onChange={handleChange}
                      placeholder="Si la cuenta está a nombre de un tercero"
                      className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                    />
                  </div>
                </div>
              </div>

              {error && (
                <div className="bg-cos-red-tint border border-[oklch(0.6_0.2_25_/_0.22)] rounded-control px-4 py-3 text-sm text-cos-red-ink">
                  {error}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="submit" disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 bg-cos-brand text-white px-4 py-2.5 rounded-control text-sm font-semibold hover:bg-cos-brand-deep disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editing ? "Guardar cambios" : "Crear proveedor"}
                </button>
                <button
                  type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2.5 rounded-control text-sm border border-cos-line hover:bg-cos-paper"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
