"use client";

import { useState, useEffect, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import {
  Users, Plus, Search, Pencil, Trash2, Loader2,
  FileText, X, RefreshCw,
} from "lucide-react";
import {
  TableContainer, Table, THead, TBody, TR, TH, TD,
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

interface Cliente {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  email?: string;
  phone?: string;
  domicilio?: string;
  codigoPostal?: string;
  facturapiId?: string;
  _count: { invoices: number };
}

const EMPTY_FORM = {
  rfc: "", razonSocial: "", regimenFiscal: "",
  email: "", phone: "", domicilio: "", codigoPostal: "",
};

export default function ClientesPage() {
  const { activeCompany } = useCompany();
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingCliente, setEditingCliente] = useState<Cliente | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const fetchClientes = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/clientes?companyId=${activeCompany.id}&search=${encodeURIComponent(search)}`
      );
      const data = await res.json();
      setClientes(data);
    } finally {
      setLoading(false);
    }
  }, [activeCompany, search]);

  useEffect(() => {
    fetchClientes();
  }, [fetchClientes]);

  function openCreate() {
    setEditingCliente(null);
    setForm(EMPTY_FORM);
    setError("");
    setShowModal(true);
  }

  function openEdit(c: Cliente) {
    setEditingCliente(c);
    setForm({
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      regimenFiscal: c.regimenFiscal,
      email: c.email ?? "",
      phone: c.phone ?? "",
      domicilio: c.domicilio ?? "",
      codigoPostal: c.codigoPostal ?? "",
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
      const url = editingCliente ? `/api/clientes/${editingCliente.id}` : "/api/clientes";
      const method = editingCliente ? "PATCH" : "POST";
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
      fetchClientes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSaving(false);
    }
  }

  async function handleSync(id: string) {
    setSyncingId(id);
    try {
      const res = await fetch(`/api/clientes/${id}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? "Error al sincronizar");
      }
      fetchClientes();
    } finally {
      setSyncingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/clientes/${deleteId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al eliminar");
      }
      setDeleteId(null);
      fetchClientes();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setDeleting(false);
    }
  }

  const regimenLabel = (value: string) =>
    REGIMENES_FISCALES.find((r) => r.value === value)?.label ?? value;

  if (!activeCompany) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-[14px] text-cos-ink-faint">
        Selecciona una empresa para ver clientes.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Clientes</h1>
          <p className="mt-1.5 text-[15px] text-cos-ink-soft">
            {activeCompany.razonSocial} · {clientes.length} cliente{clientes.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-cos-brand-deep"
        >
          <Plus className="h-4 w-4" />
          Nuevo cliente
        </button>
      </div>

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
          Cargando clientes…
        </div>
      ) : clientes.length === 0 ? (
        <div className="mt-5 flex flex-col items-center justify-center rounded-card border border-dashed border-cos-line bg-cos-card py-16 text-center">
          <Users className="mb-3 h-12 w-12 text-cos-ink-faint opacity-40" />
          <p className="text-[14px] font-semibold text-cos-ink">{search ? "Sin resultados" : "Sin clientes aún"}</p>
          <p className="mt-1 text-[13px] text-cos-ink-soft">
            {search ? "Intenta otro RFC o Razón Social" : "Agrega tu primer cliente para comenzar"}
          </p>
          {!search && (
            <button
              onClick={openCreate}
              className="mt-4 inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep"
            >
              <Plus className="h-4 w-4" /> Nuevo cliente
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
                <TH className="hidden lg:table-cell">Correo</TH>
                <TH center className="hidden sm:table-cell">Facturas</TH>
                <TH className="hidden sm:table-cell">Facturapi</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {clientes.map((c) => (
                <TR
                  key={c.id}
                  onClick={() => openEdit(c)}
                  interactive
                >
                  <TD className="font-mono text-[12px] font-medium text-cos-ink">{c.rfc}</TD>
                  <TD className="font-medium text-cos-ink">{c.razonSocial}</TD>
                  <TD className="hidden md:table-cell">
                    <span
                      title={regimenLabel(c.regimenFiscal)}
                      className="inline-flex items-center gap-1 rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] text-cos-ink-soft"
                    >
                      {c.regimenFiscal}
                    </span>
                  </TD>
                  <TD className="hidden text-[12px] text-cos-ink-soft lg:table-cell">
                    {c.email ?? "—"}
                  </TD>
                  <TD center className="hidden sm:table-cell">
                    <span className="inline-flex items-center gap-1 text-[12px] text-cos-ink-soft">
                      <FileText className="h-3.5 w-3.5" />
                      {c._count.invoices}
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    {c.facturapiId ? (
                      <span className="rounded-full bg-cos-jade-tint px-2 py-0.5 text-[12px] font-medium text-cos-jade-ink">
                        Sincronizado
                      </span>
                    ) : (
                      <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] text-cos-ink-soft">
                        Pendiente
                      </span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      {!c.facturapiId && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSync(c.id); }}
                          disabled={syncingId === c.id}
                          className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-brand-tint hover:text-cos-brand-ink"
                          title="Sincronizar con Facturapi"
                        >
                          {syncingId === c.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <RefreshCw className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                        className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-paper hover:text-cos-ink"
                        title="Editar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteId(c.id); setDeleteError(""); }}
                        className="rounded-control p-1.5 text-cos-ink-faint transition-colors hover:bg-cos-red-tint hover:text-cos-red-ink"
                        title="Eliminar"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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
                {editingCliente ? "Editar cliente" : "Nuevo cliente"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-control hover:bg-cos-paper text-cos-ink-faint"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              {/* RFC */}
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  RFC <span className="text-red-500">*</span>
                </label>
                <input
                  type="text" name="rfc" value={form.rfc} onChange={handleChange}
                  placeholder="XAXX010101000" maxLength={13} required
                  disabled={!!editingCliente?.facturapiId}
                  className="w-full px-3 py-2 border border-cos-line rounded-control text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand uppercase disabled:bg-cos-paper disabled:text-cos-ink-faint"
                />
                {editingCliente?.facturapiId ? (
                  <p className="text-xs text-cos-ink-soft mt-1">El RFC no se puede modificar (ya sincronizado con Facturapi)</p>
                ) : editingCliente ? (
                  <p className="text-xs text-cos-ink-soft mt-1">Corrígelo si está incompleto (debe tener homoclave completa: 12 o 13 caracteres).</p>
                ) : null}
              </div>

              {/* Razón Social */}
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Razón Social <span className="text-red-500">*</span>
                </label>
                <input
                  type="text" name="razonSocial" value={form.razonSocial} onChange={handleChange}
                  placeholder="Mi Empresa SA de CV" required
                  className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                />
              </div>

              {/* Régimen Fiscal */}
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Régimen Fiscal <span className="text-red-500">*</span>
                </label>
                <select
                  name="regimenFiscal" value={form.regimenFiscal} onChange={handleChange} required
                  className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand bg-cos-card"
                >
                  <option value="">Selecciona un régimen...</option>
                  {REGIMENES_FISCALES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              {/* Email + Phone */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Correo electrónico</label>
                  <input
                    type="email" name="email" value={form.email} onChange={handleChange}
                    placeholder="cliente@empresa.com"
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">Teléfono</label>
                  <input
                    type="tel" name="phone" value={form.phone} onChange={handleChange}
                    placeholder="55 1234 5678"
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                  />
                </div>
              </div>

              {/* CP + Domicilio */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Código Postal</label>
                  <input
                    type="text" name="codigoPostal" value={form.codigoPostal} onChange={handleChange}
                    placeholder="06600" maxLength={5}
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1.5">Domicilio</label>
                  <input
                    type="text" name="domicilio" value={form.domicilio} onChange={handleChange}
                    placeholder="Calle, Número, Colonia"
                    className="w-full px-3 py-2 border border-cos-line rounded-control text-sm focus:outline-none focus:ring-1 focus:ring-cos-brand focus:border-cos-brand"
                  />
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
                  {editingCliente ? "Guardar cambios" : "Crear cliente"}
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

      {/* ── Delete Confirm Modal ── */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 className="h-5 w-5 text-red-600" />
              </div>
              <h2 className="text-base font-semibold">¿Eliminar cliente?</h2>
            </div>
            <p className="text-sm text-cos-ink-soft mb-4">
              Esta acción no se puede deshacer. El cliente será eliminado permanentemente.
            </p>
            {deleteError && (
              <div className="bg-cos-red-tint border border-[oklch(0.6_0.2_25_/_0.22)] rounded-control px-4 py-3 text-sm text-cos-red-ink mb-4">
                {deleteError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleDelete} disabled={deleting}
                className="flex-1 flex items-center justify-center gap-2 bg-cos-red text-white px-4 py-2 rounded-control text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                Eliminar
              </button>
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 px-4 py-2 rounded-control text-sm border border-cos-line hover:bg-cos-paper"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
