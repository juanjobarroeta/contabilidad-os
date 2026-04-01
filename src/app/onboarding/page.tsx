"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2 } from "lucide-react";

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

export default function OnboardingPage() {
  const router = useRouter();
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

    // Basic RFC validation
    const rfcRegex = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
    if (!rfcRegex.test(form.rfc)) {
      setError("El RFC no tiene un formato válido (ej. XAXX010101000)");
      return;
    }

    if (form.codigoPostal.length !== 5) {
      setError("El código postal debe tener 5 dígitos");
      return;
    }

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

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-border w-full max-w-lg">
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-border">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Configura tu empresa</h1>
              <p className="text-sm text-muted-foreground">Ingresa los datos fiscales del SAT</p>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-8 py-6 space-y-5">
          {/* RFC */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
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
              className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary uppercase"
            />
            <p className="text-xs text-muted-foreground mt-1">
              12 caracteres para personas morales, 13 para personas físicas
            </p>
          </div>

          {/* Razón Social */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Razón Social <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="razonSocial"
              value={form.razonSocial}
              onChange={handleChange}
              placeholder="Mi Empresa SA de CV"
              required
              className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          {/* Régimen Fiscal */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Régimen Fiscal <span className="text-red-500">*</span>
            </label>
            <select
              name="regimenFiscal"
              value={form.regimenFiscal}
              onChange={handleChange}
              required
              className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white"
            >
              <option value="">Selecciona un régimen...</option>
              {REGIMENES_FISCALES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Código Postal */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Código Postal <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="codigoPostal"
              value={form.codigoPostal}
              onChange={handleChange}
              placeholder="06600"
              maxLength={5}
              pattern="[0-9]{5}"
              required
              className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          {/* Domicilio Fiscal */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Domicilio Fiscal{" "}
              <span className="text-muted-foreground font-normal">(opcional)</span>
            </label>
            <input
              type="text"
              name="domicilioFiscal"
              value={form.domicilioFiscal}
              onChange={handleChange}
              placeholder="Calle, Número, Colonia, Ciudad"
              className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creando empresa...
              </>
            ) : (
              "Crear empresa y continuar"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
