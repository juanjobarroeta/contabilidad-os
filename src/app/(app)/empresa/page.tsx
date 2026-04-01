"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Building2, Plus, Loader2, Pencil } from "lucide-react";

const REGIMENES_FISCALES = [
  { value: "601", label: "601 – General de Ley Personas Morales" },
  { value: "603", label: "603 – Personas Morales con Fines no Lucrativos" },
  { value: "605", label: "605 – Sueldos y Salarios e Ingresos Asimilados" },
  { value: "606", label: "606 – Arrendamiento" },
  { value: "607", label: "607 – Enajenación o Adquisición de Bienes" },
  { value: "608", label: "608 – Demás ingresos" },
  { value: "612", label: "612 – Personas Físicas con Actividades Empresariales y Profesionales" },
  { value: "616", label: "616 – Sin obligaciones fiscales" },
  { value: "620", label: "620 – Sociedades Cooperativas de Producción" },
  { value: "621", label: "621 – Incorporación Fiscal" },
  { value: "622", label: "622 – Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras" },
  { value: "625", label: "625 – Plataformas Tecnológicas" },
  { value: "626", label: "626 – Régimen Simplificado de Confianza (RESICO)" },
];

export default function EmpresaPage() {
  const { companies, activeCompany, setActiveCompany } = useCompany();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    rfc: "",
    razonSocial: "",
    regimenFiscal: "",
    codigoPostal: "",
    domicilioFiscal: "",
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: name === "rfc" ? value.toUpperCase() : value,
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al crear la empresa");
      }
      const newCompany = await res.json();
      setActiveCompany(newCompany);
      setShowForm(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Mi Empresa</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Gestiona tus empresas y datos fiscales
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Nueva empresa
        </button>
      </div>

      {/* Add Company Form */}
      {showForm && (
        <div className="bg-white border border-border rounded-xl p-6 mb-6 shadow-sm">
          <h2 className="text-base font-semibold mb-4">Agregar nueva empresa</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  RFC <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="rfc"
                  value={form.rfc}
                  onChange={handleChange}
                  placeholder="XAXX010101000"
                  maxLength={13}
                  required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 uppercase"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Código Postal <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="codigoPostal"
                  value={form.codigoPostal}
                  onChange={handleChange}
                  placeholder="06600"
                  maxLength={5}
                  required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Razón Social <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="razonSocial"
                value={form.razonSocial}
                onChange={handleChange}
                placeholder="Mi Empresa SA de CV"
                required
                className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Régimen Fiscal <span className="text-red-500">*</span>
              </label>
              <select
                name="regimenFiscal"
                value={form.regimenFiscal}
                onChange={handleChange}
                required
                className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white"
              >
                <option value="">Selecciona un régimen...</option>
                {REGIMENES_FISCALES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Domicilio Fiscal <span className="text-muted-foreground font-normal">(opcional)</span>
              </label>
              <input
                type="text"
                name="domicilioFiscal"
                value={form.domicilioFiscal}
                onChange={handleChange}
                placeholder="Calle, Número, Colonia, Ciudad"
                className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Crear empresa
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-accent"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Company List */}
      <div className="space-y-3">
        {companies.map((company) => (
          <div
            key={company.id}
            className={`bg-white border rounded-xl p-5 shadow-sm flex items-center justify-between transition-colors ${
              activeCompany?.id === company.id
                ? "border-primary ring-1 ring-primary/20"
                : "border-border"
            }`}
          >
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground">{company.razonSocial}</p>
                <p className="text-sm text-muted-foreground font-mono">{company.rfc}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Régimen {company.regimenFiscal}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeCompany?.id === company.id ? (
                <span className="text-xs bg-primary/10 text-primary font-medium px-2.5 py-1 rounded-full">
                  Activa
                </span>
              ) : (
                <button
                  onClick={() => setActiveCompany(company)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  Activar
                </button>
              )}
              <button className="p-1.5 rounded-md hover:bg-accent text-muted-foreground">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
