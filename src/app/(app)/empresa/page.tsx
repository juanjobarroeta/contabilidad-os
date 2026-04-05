"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import {
  Building2, Plus, Loader2, Pencil, CheckCircle2,
  Zap, Key, AlertCircle, Trash2, ExternalLink, Eye, EyeOff, X,
  Shield, Upload,
} from "lucide-react";

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

interface CompanyDetail {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
  domicilioFiscal?: string;
  nombreComercial?: string;
  email?: string;
  telefono?: string;
  facturapiOrgId?: string;
  facturapiApiKey?: string;
  csdCer?: string;
  csdKey?: string;
  fielCer?: string;
  fielKey?: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function EmpresaPage() {
  const { companies, activeCompany, setActiveCompany } = useCompany();
  const router = useRouter();

  // Add company form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState("");
  const [addForm, setAddForm] = useState({
    rfc: "", razonSocial: "", regimenFiscal: "", codigoPostal: "", domicilioFiscal: "",
  });

  // Active company detail (from DB, includes sensitive fields not in provider)
  const [companyDetail, setCompanyDetail] = useState<CompanyDetail | null>(null);

  // Facturapi setup
  const [fpLoading, setFpLoading] = useState(false);
  const [fpError, setFpError] = useState("");
  const [fpSuccess, setFpSuccess] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [manualKey, setManualKey] = useState("");
  const [manualOrgId, setManualOrgId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // FIEL upload
  const [fielCerFile, setFielCerFile] = useState<File | null>(null);
  const [fielKeyFile, setFielKeyFile] = useState<File | null>(null);
  const [fielPassword, setFielPassword] = useState("");
  const [showFielPassword, setShowFielPassword] = useState(false);
  const [fielSaving, setFielSaving] = useState(false);
  const [fielSuccess, setFielSuccess] = useState("");
  const [fielError, setFielError] = useState("");

  // Delete company
  const [disconnectLoading, setDisconnectLoading] = useState(false);

  const fetchCompanyDetail = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/companies/${activeCompany.id}`);
    if (res.ok) {
      const data = await res.json();
      setCompanyDetail(data);
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchCompanyDetail();
    setFpError("");
    setFpSuccess("");
    setShowManualKey(false);
  }, [fetchCompanyDetail]);

  // Add company
  function handleAddChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setAddForm((p) => ({ ...p, [name]: name === "rfc" ? value.toUpperCase() : value }));
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAddLoading(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al crear la empresa");
      }
      const newCompany = await res.json();
      setActiveCompany(newCompany);
      setShowAddForm(false);
      router.refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setAddLoading(false);
    }
  }

  // Auto-setup Facturapi
  async function handleAutoSetup() {
    if (!activeCompany) return;
    setFpLoading(true);
    setFpError("");
    setFpSuccess("");
    try {
      const res = await fetch(`/api/companies/${activeCompany.id}/facturapi`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error en Facturapi");
      setFpSuccess(data.message);
      fetchCompanyDetail();
    } catch (err) {
      setFpError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setFpLoading(false);
    }
  }

  // Manual key save
  async function handleSaveManualKey() {
    if (!activeCompany || !manualKey.trim()) return;
    setSavingKey(true);
    setFpError("");
    try {
      const res = await fetch(`/api/companies/${activeCompany.id}/facturapi`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: manualKey.trim(), orgId: manualOrgId.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al guardar");
      }
      setFpSuccess("Clave de API guardada correctamente.");
      setShowManualKey(false);
      setManualKey("");
      setManualOrgId("");
      fetchCompanyDetail();
    } catch (err) {
      setFpError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSavingKey(false);
    }
  }

  // Disconnect Facturapi
  async function handleDisconnect() {
    if (!activeCompany) return;
    setDisconnectLoading(true);
    try {
      await fetch(`/api/companies/${activeCompany.id}/facturapi`, { method: "DELETE" });
      setFpSuccess("");
      fetchCompanyDetail();
    } finally {
      setDisconnectLoading(false);
    }
  }

  async function handleFielUpload() {
    if (!activeCompany) return;
    if (!fielCerFile || !fielKeyFile || !fielPassword) {
      setFielError("Sube el .cer, el .key y la contraseña de tu e.firma");
      return;
    }
    setFielSaving(true);
    setFielError("");
    setFielSuccess("");
    try {
      const fielCer = await fileToBase64(fielCerFile);
      const fielKey = await fileToBase64(fielKeyFile);
      const res = await fetch(`/api/companies/${activeCompany.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fielCer, fielKey, fielPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al guardar");
      }
      setFielSuccess("e.firma guardada correctamente. Ya puedes sincronizar CFDIs del SAT.");
      setFielCerFile(null);
      setFielKeyFile(null);
      setFielPassword("");
      fetchCompanyDetail();
    } catch (err) {
      setFielError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setFielSaving(false);
    }
  }

  const isConnected = !!(companyDetail?.facturapiApiKey);
  const hasCsd = !!(companyDetail?.csdCer && companyDetail?.csdKey);
  const hasFiel = !!(companyDetail?.fielCer && companyDetail?.fielKey);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Mi Empresa</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Gestiona tus empresas y configuración fiscal</p>
        </div>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Nueva empresa
        </button>
      </div>

      {/* Add Company Form */}
      {showAddForm && (
        <div className="bg-white border border-border rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">Agregar nueva empresa</h2>
            <button onClick={() => setShowAddForm(false)} className="p-1.5 rounded hover:bg-accent text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleAddSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">RFC <span className="text-red-500">*</span></label>
                <input type="text" name="rfc" value={addForm.rfc} onChange={handleAddChange}
                  placeholder="XAXX010101000" maxLength={13} required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 uppercase" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Código Postal <span className="text-red-500">*</span></label>
                <input type="text" name="codigoPostal" value={addForm.codigoPostal} onChange={handleAddChange}
                  placeholder="06600" maxLength={5} required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Razón Social <span className="text-red-500">*</span></label>
              <input type="text" name="razonSocial" value={addForm.razonSocial} onChange={handleAddChange}
                placeholder="Mi Empresa SA de CV" required
                className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Régimen Fiscal <span className="text-red-500">*</span></label>
              <select name="regimenFiscal" value={addForm.regimenFiscal} onChange={handleAddChange} required
                className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                <option value="">Selecciona...</option>
                {REGIMENES_FISCALES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            {addError && (
              <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{addError}</div>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={addLoading}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                {addLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Crear empresa
              </button>
              <button type="button" onClick={() => setShowAddForm(false)}
                className="px-4 py-2 rounded-md text-sm border border-border hover:bg-accent">Cancelar</button>
            </div>
          </form>
        </div>
      )}

      {/* Company Cards */}
      <div className="space-y-3 mb-8">
        {companies.map((company) => (
          <div key={company.id}
            className={`bg-white border rounded-xl p-5 shadow-sm flex items-center justify-between transition-colors ${
              activeCompany?.id === company.id ? "border-primary ring-1 ring-primary/20" : "border-border"
            }`}
          >
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold">{company.razonSocial}</p>
                <p className="text-sm text-muted-foreground font-mono">{company.rfc}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Régimen {company.regimenFiscal}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeCompany?.id === company.id ? (
                <span className="text-xs bg-primary/10 text-primary font-medium px-2.5 py-1 rounded-full">Activa</span>
              ) : (
                <button onClick={() => setActiveCompany(company)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent text-muted-foreground transition-colors">
                  Activar
                </button>
              )}
              <button className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="Editar">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Facturapi Setup + FIEL ── */}
      {activeCompany && (
        <>
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${isConnected ? "bg-green-100" : "bg-gray-100"}`}>
                <Zap className={`h-4 w-4 ${isConnected ? "text-green-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <h2 className="font-semibold text-sm">Facturapi — Timbrado CFDI</h2>
                <p className="text-xs text-muted-foreground">{activeCompany.razonSocial}</p>
              </div>
            </div>
            {isConnected && (
              <span className="flex items-center gap-1.5 text-xs bg-green-100 text-green-700 font-medium px-2.5 py-1 rounded-full">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Conectado
              </span>
            )}
          </div>

          <div className="px-6 py-5 space-y-5">
            {/* Status */}
            {isConnected ? (
              <div className="space-y-3">
                {/* Org info */}
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5">
                      {companyDetail?.facturapiOrgId && (
                        <div>
                          <span className="text-xs text-muted-foreground">Org ID</span>
                          <p className="font-mono text-xs">{companyDetail.facturapiOrgId}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-xs text-muted-foreground">API Key</span>
                        <div className="flex items-center gap-2">
                          <p className="font-mono text-xs">
                            {showKey
                              ? companyDetail?.facturapiApiKey
                              : companyDetail?.facturapiApiKey?.substring(0, 12) + "••••••••••••"}
                          </p>
                          <button onClick={() => setShowKey((v) => !v)}
                            className="text-muted-foreground hover:text-foreground">
                            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">CSD</span>
                        <p className="text-xs font-medium">
                          {hasCsd ? (
                            <span className="text-green-700">✓ Certificado guardado</span>
                          ) : (
                            <span className="text-amber-600">⚠ Sin CSD — configúralo en el onboarding</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <a href="https://app.facturapi.io" target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0">
                      Ver en Facturapi <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

                {/* Re-sync button */}
                <button onClick={handleAutoSetup} disabled={fpLoading}
                  className="flex items-center gap-2 text-sm px-4 py-2 border border-border rounded-md hover:bg-accent disabled:opacity-50">
                  {fpLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  Re-sincronizar datos legales y CSD
                </button>

                {/* Disconnect */}
                <button onClick={handleDisconnect} disabled={disconnectLoading}
                  className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 px-4 py-2 rounded-md hover:bg-red-50 disabled:opacity-50">
                  {disconnectLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Desconectar Facturapi
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                  <p className="font-semibold mb-1">Para timbrar CFDIs necesitas Facturapi</p>
                  <p>Facturapi actúa como PAC (Proveedor Autorizado de Certificación) ante el SAT. Crea una cuenta en <a href="https://facturapi.io" target="_blank" rel="noopener noreferrer" className="underline font-medium">facturapi.io</a> y agrega tu clave secreta en Railway → Variables → <code>FACTURAPI_SECRET_KEY</code>.</p>
                </div>

                {/* Option 1: Auto setup */}
                <div className="border border-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Opción 1 — Configuración automática</h3>
                    <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">Recomendada</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Crea la organización en Facturapi, sube tus datos fiscales y el CSD automáticamente usando tu clave de administrador.
                  </p>
                  {!hasCsd && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-700 mb-3">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      No hay CSD guardado. La organización se creará pero no podrá timbrar hasta que subas el CSD desde el onboarding.
                    </div>
                  )}
                  <button onClick={handleAutoSetup} disabled={fpLoading}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                    {fpLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    {fpLoading ? "Configurando..." : "Configurar automáticamente"}
                  </button>
                </div>

                {/* Option 2: Manual */}
                <div className="border border-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">Opción 2 — Pegar clave manualmente</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Si ya tienes una organización en Facturapi, pega directamente su clave de API.
                  </p>
                  {!showManualKey ? (
                    <button onClick={() => setShowManualKey(true)}
                      className="flex items-center gap-2 text-sm px-4 py-2 border border-border rounded-md hover:bg-accent">
                      <Key className="h-4 w-4" />
                      Ingresar clave manualmente
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium mb-1">API Key de la organización <span className="text-red-500">*</span></label>
                        <div className="relative">
                          <input
                            type={showKey ? "text" : "password"}
                            value={manualKey}
                            onChange={(e) => setManualKey(e.target.value)}
                            placeholder="sk_live_... o sk_test_..."
                            className="w-full px-3 py-2 pr-10 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <button type="button" onClick={() => setShowKey((v) => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Org ID <span className="text-muted-foreground font-normal">(opcional)</span></label>
                        <input type="text" value={manualOrgId} onChange={(e) => setManualOrgId(e.target.value)}
                          placeholder="org_xxxxxxxxxxxxxxxxxx"
                          className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleSaveManualKey} disabled={savingKey || !manualKey.trim()}
                          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                          {savingKey && <Loader2 className="h-4 w-4 animate-spin" />}
                          Guardar
                        </button>
                        <button onClick={() => setShowManualKey(false)}
                          className="px-4 py-2 rounded-md text-sm border border-border hover:bg-accent">Cancelar</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Feedback messages */}
            {fpSuccess && (
              <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                {fpSuccess}
              </div>
            )}
            {fpError && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {fpError}
              </div>
            )}
          </div>
        </div>

        {/* ── e.firma / FIEL ── */}
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                <Shield className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <h2 className="font-semibold text-sm">e.firma / FIEL</h2>
                <p className="text-xs text-muted-foreground">Requerida para sincronizar CFDIs del SAT</p>
              </div>
            </div>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${hasFiel ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
              {hasFiel ? "✓ Configurada" : "Sin configurar"}
            </span>
          </div>

          <div className="px-5 py-4 space-y-4">
            {hasFiel ? (
              <div className="space-y-3">
                <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
                  <p className="font-medium">e.firma almacenada de forma segura</p>
                  <p className="text-xs mt-0.5 text-green-700">Usada para descargar CFDIs del SAT. Actualiza los archivos si tu e.firma expiró o cambió.</p>
                </div>
                <p className="text-xs text-muted-foreground">Para actualizar, sube los nuevos archivos:</p>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
                <p className="font-medium mb-1">¿Qué es la e.firma?</p>
                <p>La Firma Electrónica Avanzada (FIEL) te permite autenticarte ante el SAT para descargar todos tus CFDIs emitidos y recibidos — necesario para calcular IVA acreditable con precisión.</p>
              </div>
            )}

            {/* Upload fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1.5">Certificado e.firma <code className="bg-gray-100 px-1 rounded">.cer</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-xs cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {fielCerFile ? fielCerFile.name : "Seleccionar .cer"}
                  </span>
                  <input type="file" accept=".cer" className="hidden"
                    onChange={(e) => setFielCerFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">Llave privada <code className="bg-gray-100 px-1 rounded">.key</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-xs cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {fielKeyFile ? fielKeyFile.name : "Seleccionar .key"}
                  </span>
                  <input type="file" accept=".key" className="hidden"
                    onChange={(e) => setFielKeyFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5">Contraseña de la e.firma</label>
              <div className="relative">
                <input
                  type={showFielPassword ? "text" : "password"}
                  value={fielPassword}
                  onChange={(e) => setFielPassword(e.target.value)}
                  placeholder="Contraseña de la llave privada"
                  className="w-full px-3 py-2 pr-10 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button type="button" onClick={() => setShowFielPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showFielPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {fielSuccess && (
              <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                {fielSuccess}
              </div>
            )}
            {fielError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {fielError}
              </div>
            )}

            <button
              onClick={handleFielUpload}
              disabled={fielSaving || !fielCerFile || !fielKeyFile || !fielPassword}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {fielSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              {hasFiel ? "Actualizar e.firma" : "Guardar e.firma"}
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
