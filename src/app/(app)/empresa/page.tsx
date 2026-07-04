"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Money } from "@/components/ui";
import Link from "next/link";
import {
  Building2, Plus, Loader2, Pencil, CheckCircle2,
  Zap, Key, AlertCircle, Trash2, ExternalLink, Eye, EyeOff, X,
  Shield, Upload, FileKey2, FileText, Sparkles, ClipboardCheck, ChevronRight,
} from "lucide-react";

type DocType = "CSF" | "TARJETA_IMSS" | "ACUSE_ANUAL" | "ACUSE_MENSUAL" | "OTRO";
type ImportDoc = {
  id: string;
  fileName: string;
  type: DocType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extracted: any;
  warnings: string[];
};
const DOC_LABEL: Record<DocType, string> = {
  CSF: "Constancia de Situación Fiscal",
  TARJETA_IMSS: "Tarjeta IMSS",
  ACUSE_ANUAL: "Declaración Anual",
  ACUSE_MENSUAL: "Declaración Mensual",
  OTRO: "No reconocido",
};

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
  fielVigencia?: string | null;
  fielEstado?: "ok" | "por_vencer" | "vencida" | "sin_fiel";
  registroPatronal?: string | null;
  plataformaActividad?: string | null;
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
    rfc: "", razonSocial: "", regimenFiscal: "", codigoPostal: "", domicilioFiscal: "", grupoId: "",
  });
  // Grupos del despacho (para asignar la empresa a un grupo al crearla).
  const [grupos, setGrupos] = useState<{ id: string; nombre: string }[]>([]);
  const loadGrupos = useCallback(async () => {
    try {
      const res = await fetch("/api/grupos");
      if (res.ok) setGrupos((await res.json()).grupos ?? []);
    } catch { /* sin despacho → sin grupos */ }
  }, []);
  useEffect(() => { loadGrupos(); }, [loadGrupos]);
  async function crearGrupo() {
    const nombre = window.prompt("Nombre del grupo (p.ej. Grupo Norte):")?.trim();
    if (!nombre) return;
    const res = await fetch("/api/grupos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre }),
    });
    if (res.ok) {
      const g = await res.json();
      await loadGrupos();
      setAddForm((p) => ({ ...p, grupoId: g.id }));
    } else {
      setAddError((await res.json()).error ?? "No se pudo crear el grupo");
    }
  }

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

  // Nómina — Registro Patronal
  const [rpValue, setRpValue] = useState("");
  const [rpSaving, setRpSaving] = useState(false);
  const [rpMessage, setRpMessage] = useState("");

  // CSD upload state
  const [csdCerFile, setCsdCerFile] = useState<File | null>(null);
  const [csdKeyFile, setCsdKeyFile] = useState<File | null>(null);
  const [csdPassword, setCsdPassword] = useState("");
  const [csdSaving, setCsdSaving] = useState(false);
  const [csdError, setCsdError] = useState("");
  const [csdSuccess, setCsdSuccess] = useState("");

  // Live Facturapi status (pending_steps, isProductionReady)
  const [fpStatus, setFpStatus] = useState<{
    orgId: string | null;
    isProductionReady?: boolean;
    pendingSteps?: Array<{ type: string; description: string }>;
    taxId?: string | null;
    hasCertificate?: boolean;
    dashboardUrl?: string;
  } | null>(null);
  const [showFielPassword, setShowFielPassword] = useState(false);
  const [fielSaving, setFielSaving] = useState(false);
  const [fielSuccess, setFielSuccess] = useState("");
  const [fielError, setFielError] = useState("");

  // Import declarations
  const [importDocs, setImportDocs] = useState<ImportDoc[]>([]);
  const [importParsing, setImportParsing] = useState(false);
  const [importSaving, setImportSaving] = useState(false);
  const [importSuccess, setImportSuccess] = useState("");
  const [importError, setImportError] = useState("");
  const [historicalDecs, setHistoricalDecs] = useState<{ id: string; tipo: string; periodo: string; status: string; isrPagar: number | null; ivaPagar: number | null; ivaSaldoFavor: number | null; isrCoeficienteUtilidad: number | null }[]>([]);

  // Import Contabilidad Electrónica (Anexo 24)
  const [ceCatalogoFile, setCeCatalogoFile] = useState<File | null>(null);
  const [ceBalanzaFile, setCeBalanzaFile] = useState<File | null>(null);
  const [ceUsar, setCeUsar] = useState<"final" | "inicial">("final");
  const [ceSaving, setCeSaving] = useState(false);
  const [ceSuccess, setCeSuccess] = useState("");
  const [ceError, setCeError] = useState("");
  const [ceSyntageSaving, setCeSyntageSaving] = useState(false);

  // Delete company
  const [disconnectLoading, setDisconnectLoading] = useState(false);

  const fetchCompanyDetail = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/companies/${activeCompany.id}`);
    if (res.ok) {
      const data = await res.json();
      setCompanyDetail(data);
      setRpValue(data.registroPatronal ?? "");
    }
    // Also fetch live Facturapi status (best-effort, don't block)
    try {
      const sRes = await fetch(`/api/companies/${activeCompany.id}/facturapi/status`);
      if (sRes.ok) setFpStatus(await sRes.json());
    } catch { /* ignore */ }
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

  async function handleSaveRegistroPatronal() {
    if (!activeCompany) return;
    setRpSaving(true);
    setRpMessage("");
    try {
      const res = await fetch(`/api/companies/${activeCompany.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registroPatronal: rpValue.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Error");
      }
      setRpMessage("✓ Guardado");
      fetchCompanyDetail();
    } catch (e) {
      setRpMessage(e instanceof Error ? e.message : "Error");
    } finally {
      setRpSaving(false);
    }
  }

  async function handleSavePlataformaActividad(value: string) {
    if (!activeCompany) return;
    try {
      await fetch(`/api/companies/${activeCompany.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plataformaActividad: value }),
      });
      fetchCompanyDetail();
    } catch {
      /* noop — el selector refleja el valor guardado al recargar */
    }
  }

  async function handleCsdUpload() {
    if (!activeCompany) return;
    if (!csdCerFile || !csdKeyFile || !csdPassword) {
      setCsdError("Sube el .cer, el .key y la contraseña del CSD");
      return;
    }
    setCsdSaving(true);
    setCsdError("");
    setCsdSuccess("");
    try {
      const csdCer = await fileToBase64(csdCerFile);
      const csdKey = await fileToBase64(csdKeyFile);
      const res = await fetch(`/api/companies/${activeCompany.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csdCer, csdKey, csdPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar el CSD");

      // The PATCH route auto-runs Facturapi provisioning when CSD changes.
      // The result is in data.facturapi — surface a meaningful message.
      const fp = data.facturapi;
      if (fp?.hasLiveKey) {
        setCsdSuccess("CSD guardado y clave live de Facturapi generada. Ya puedes timbrar CFDIs.");
      } else if (fp?.csdUploaded) {
        setCsdSuccess("CSD guardado y subido a Facturapi. Procesando llave live…");
      } else if (fp?.warning) {
        setCsdSuccess(`CSD guardado. ${fp.warning}`);
      } else {
        setCsdSuccess("CSD guardado correctamente.");
      }
      setCsdCerFile(null);
      setCsdKeyFile(null);
      setCsdPassword("");
      fetchCompanyDetail();
    } catch (err) {
      setCsdError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCsdSaving(false);
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

  // Load historical declarations
  const loadHistorical = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/impuestos/historical?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setHistoricalDecs(data.declarations ?? []);
      }
    } catch { /* silent */ }
  }, [activeCompany]);

  useEffect(() => { loadHistorical(); }, [loadHistorical]);

  // ── Import declarations handlers ──
  async function handleImportUpload(files: FileList | null) {
    if (!files || files.length === 0 || !activeCompany) return;
    setImportParsing(true);
    setImportError("");
    setImportSuccess("");
    try {
      const results: ImportDoc[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/onboarding/parse-document", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          setImportError(`${file.name}: ${data.error ?? "No se pudo procesar"}`);
          continue;
        }
        if (data.type === "ACUSE_ANUAL" || data.type === "ACUSE_MENSUAL") {
          results.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fileName: file.name,
            type: data.type,
            extracted: data.extracted,
            warnings: data.warnings ?? [],
          });
        } else {
          setImportError(
            `${file.name}: Detectado como "${DOC_LABEL[data.type as DocType]}". Solo se importan declaraciones anuales y mensuales.`
          );
        }
      }
      setImportDocs((prev) => [...prev, ...results]);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setImportParsing(false);
    }
  }

  function removeImportDoc(id: string) {
    setImportDocs((prev) => prev.filter((d) => d.id !== id));
  }

  async function handleImportSave() {
    if (!activeCompany || importDocs.length === 0) return;
    setImportSaving(true);
    setImportError("");
    setImportSuccess("");
    try {
      const anualDoc = importDocs.find((d) => d.type === "ACUSE_ANUAL");
      const mensualDocs = importDocs.filter((d) => d.type === "ACUSE_MENSUAL");

      const res = await fetch(`/api/companies/${activeCompany.id}/import-declarations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acuseAnual: anualDoc?.extracted?.acuseAnual ?? null,
          acusesMensuales: mensualDocs.map((d) => d.extracted?.acuseMensual).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al importar");

      setImportSuccess(
        `✓ ${data.total} declaración${data.total !== 1 ? "es" : ""} importada${data.total !== 1 ? "s" : ""}: ${data.created.join(", ")}`
      );
      setImportDocs([]);
      loadHistorical();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setImportSaving(false);
    }
  }

  // ── Importar Contabilidad Electrónica (Anexo 24) ──
  async function handleImportCe() {
    if (!activeCompany) return;
    if (!ceCatalogoFile && !ceBalanzaFile) {
      setCeError("Sube el XML del catálogo de cuentas y/o de la balanza de comprobación.");
      return;
    }
    setCeSaving(true);
    setCeError("");
    setCeSuccess("");
    try {
      const form = new FormData();
      form.append("companyId", activeCompany.id);
      if (ceCatalogoFile) form.append("catalogo", ceCatalogoFile);
      if (ceBalanzaFile) form.append("balanza", ceBalanzaFile);
      form.append("usar", ceUsar);
      const res = await fetch("/api/contabilidad/import-ce", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo importar la Contabilidad Electrónica");

      const partes: string[] = [];
      if (data.catalogo) {
        partes.push(
          `Catálogo: ${data.catalogo.creadas} cuenta(s) nueva(s), ${data.catalogo.actualizadas} actualizada(s).`,
        );
      }
      if (data.balanza) {
        partes.push(
          `Saldos iniciales: ${data.balanza.entries} partida(s) por ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(data.balanza.totalCargos)}.`,
        );
        if (data.balanza.cuentasSinCatalogo?.length) {
          partes.push(
            `${data.balanza.cuentasSinCatalogo.length} cuenta(s) de la balanza no estaban en el catálogo y se omitieron.`,
          );
        }
      }
      setCeSuccess(partes.join(" "));
      setCeCatalogoFile(null);
      setCeBalanzaFile(null);
    } catch (err) {
      setCeError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCeSaving(false);
    }
  }

  // ── Traer la Contabilidad Electrónica automáticamente desde Syntage ──
  async function handleImportCeSyntage() {
    if (!activeCompany) return;
    setCeSyntageSaving(true);
    setCeError("");
    setCeSuccess("");
    try {
      const res = await fetch("/api/contabilidad/import-ce-syntage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo traer la Contabilidad Electrónica de Syntage");

      const partes: string[] = [];
      if (data.catalogo) {
        partes.push(
          `Catálogo: ${data.catalogo.creadas} cuenta(s) nueva(s), ${data.catalogo.actualizadas} actualizada(s).`,
        );
      }
      if (data.balanza) {
        partes.push(
          `Saldos iniciales: ${data.balanza.entries} partida(s) por ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(data.balanza.totalCargos)}.`,
        );
        if (data.balanza.cuentasSinCatalogo?.length) {
          partes.push(
            `${data.balanza.cuentasSinCatalogo.length} cuenta(s) de la balanza no estaban en el catálogo y se omitieron.`,
          );
        }
      }
      setCeSuccess(partes.length ? partes.join(" ") : "Contabilidad Electrónica importada desde Syntage.");
    } catch (err) {
      setCeError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCeSyntageSaving(false);
    }
  }

  const isConnected = !!(companyDetail?.facturapiApiKey);
  const hasCsd = !!(companyDetail?.csdCer && companyDetail?.csdKey);
  const hasFiel = !!(companyDetail?.fielCer && companyDetail?.fielKey);
  // Vigencia de la e.firma: "Configurada" ya no basta — un certificado vencido
  // detiene la sincronización con el SAT aunque los archivos estén cargados.
  const fielEstado = hasFiel ? (companyDetail?.fielEstado ?? "ok") : "sin_fiel";
  const fielVigenciaFmt = companyDetail?.fielVigencia
    ? new Date(companyDetail.fielVigencia).toLocaleDateString("es-MX", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Mexico_City",
      })
    : null;
  const fielBadge =
    fielEstado === "vencida"
      ? { clase: "bg-cos-red-tint text-cos-red-ink", texto: fielVigenciaFmt ? `Vencida el ${fielVigenciaFmt}` : "Vencida" }
      : fielEstado === "por_vencer"
        ? { clase: "bg-cos-amber-tint text-cos-amber-ink", texto: fielVigenciaFmt ? `Vence el ${fielVigenciaFmt}` : "Por vencer" }
        : fielEstado === "ok"
          ? { clase: "bg-cos-jade-tint text-cos-jade-ink", texto: fielVigenciaFmt ? `Vigente hasta ${fielVigenciaFmt}` : "✓ Configurada" }
          : { clase: "bg-cos-amber-tint text-cos-amber-ink", texto: "Sin configurar" };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Mi Empresa</h1>
          <p className="text-sm text-cos-ink-soft mt-0.5">Gestiona tus empresas y configuración fiscal</p>
        </div>
        <a
          href="/onboarding?from=empresas&returnTo=/empresa"
          className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep"
        >
          <Plus className="h-4 w-4" />
          Nueva empresa
        </a>
      </div>

      {/* Add Company Form */}
      {showAddForm && (
        <div className="bg-cos-card border border-cos-line rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">Agregar nueva empresa</h2>
            <button onClick={() => setShowAddForm(false)} className="p-1.5 rounded hover:bg-cos-paper text-cos-ink-soft">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleAddSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">RFC <span className="text-cos-red-ink">*</span></label>
                <input type="text" name="rfc" value={addForm.rfc} onChange={handleAddChange}
                  placeholder="XAXX010101000" maxLength={13} required
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30 uppercase" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Código Postal <span className="text-cos-red-ink">*</span></label>
                <input type="text" name="codigoPostal" value={addForm.codigoPostal} onChange={handleAddChange}
                  placeholder="06600" maxLength={5} required
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Razón Social <span className="text-cos-red-ink">*</span></label>
              <input type="text" name="razonSocial" value={addForm.razonSocial} onChange={handleAddChange}
                placeholder="Mi Empresa SA de CV" required
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Régimen Fiscal <span className="text-cos-red-ink">*</span></label>
              <select name="regimenFiscal" value={addForm.regimenFiscal} onChange={handleAddChange} required
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
                <option value="">Selecciona...</option>
                {REGIMENES_FISCALES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            {/* Grupo (opcional): agrupa empresas del mismo dueño que se facturan
                entre sí → habilita detección intercompañía (Art. 69-B) y comisiones. */}
            <div>
              <label className="block text-sm font-medium mb-1.5">Grupo <span className="text-cos-ink-soft">(opcional)</span></label>
              <div className="flex gap-2">
                <select name="grupoId" value={addForm.grupoId} onChange={handleAddChange}
                  className="flex-1 px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
                  <option value="">Sin grupo</option>
                  {grupos.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
                </select>
                <button type="button" onClick={crearGrupo}
                  className="px-3 py-2 rounded-md text-sm border border-cos-line hover:bg-cos-paper whitespace-nowrap">+ Nuevo grupo</button>
              </div>
              <p className="text-xs text-cos-ink-soft mt-1">Empresas del mismo dueño que se facturan entre sí. Se usa para detectar operaciones intercompañía.</p>
            </div>
            {addError && (
              <div className="bg-cos-red-tint border border-cos-red-ink/20 rounded-md px-4 py-3 text-sm text-cos-red-ink">{addError}</div>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={addLoading}
                className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50">
                {addLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Crear empresa
              </button>
              <button type="button" onClick={() => setShowAddForm(false)}
                className="px-4 py-2 rounded-md text-sm border border-cos-line hover:bg-cos-paper">Cancelar</button>
            </div>
          </form>
        </div>
      )}

      {/* Company Cards */}
      <div className="space-y-3 mb-8">
        {companies.map((company) => (
          <div key={company.id}
            className={`bg-cos-card border rounded-xl p-5 shadow-sm flex items-center justify-between transition-colors ${
              activeCompany?.id === company.id ? "border-cos-brand ring-1 ring-cos-brand/20" : "border-cos-line"
            }`}
          >
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
                <Building2 className="h-5 w-5 text-cos-brand-ink" />
              </div>
              <div>
                <p className="font-semibold">{company.razonSocial}</p>
                <p className="text-sm text-cos-ink-soft font-mono">{company.rfc}</p>
                <p className="text-xs text-cos-ink-soft mt-0.5">Régimen {company.regimenFiscal}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeCompany?.id === company.id ? (
                <span className="text-xs bg-cos-brand-tint text-cos-brand-ink font-medium px-2.5 py-1 rounded-full">Activa</span>
              ) : (
                <button onClick={() => setActiveCompany(company)}
                  className="text-xs px-3 py-1.5 rounded-md border border-cos-line hover:bg-cos-paper text-cos-ink-soft transition-colors">
                  Activar
                </button>
              )}
              <a
                href={`/configuracion/empresas/${company.id}`}
                className="p-1.5 rounded-md hover:bg-cos-paper text-cos-ink-soft"
                title="Editar"
              >
                <Pencil className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* ── Nómina — Registro Patronal IMSS ── */}
      {activeCompany && (
        <div className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
          <div className="flex items-start gap-3 mb-3">
            <div className="h-9 w-9 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-cos-brand-ink" />
            </div>
            <div>
              <h2 className="font-semibold text-sm">Registro Patronal IMSS</h2>
              <p className="text-xs text-cos-ink-soft">Requerido para emitir CFDI de nómina. Aparece en tu Tarjeta de Identificación Patronal.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={rpValue}
              onChange={(e) => setRpValue(e.target.value.toUpperCase())}
              placeholder="E.g. E0818935102"
              className="flex-1 px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
            <button
              onClick={handleSaveRegistroPatronal}
              disabled={rpSaving}
              className="bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50 flex items-center gap-2"
            >
              {rpSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar
            </button>
          </div>
          {rpMessage && (
            <p className={`text-xs mt-2 ${rpMessage.startsWith("✓") ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>
              {rpMessage}
            </p>
          )}
          {companyDetail?.registroPatronal && !rpMessage && (
            <p className="text-xs text-cos-ink-soft mt-2">
              Actual: <code className="font-mono text-cos-ink">{companyDetail.registroPatronal}</code>
            </p>
          )}
        </div>
      )}

      {/* ── Plataformas tecnológicas (625) — tipo de actividad / tasa ── */}
      {activeCompany && companyDetail?.regimenFiscal === "625" && (
        <div className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
          <div className="flex items-start gap-3 mb-3">
            <div className="h-9 w-9 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-cos-brand-ink" />
            </div>
            <div>
              <h2 className="font-semibold text-sm">Plataformas tecnológicas — tipo de actividad</h2>
              <p className="text-xs text-cos-ink-soft">Define la tasa de retención de ISR (Art. 113-A LISR). Sin configurar, el cálculo asume servicios (1%).</p>
            </div>
          </div>
          <select
            value={companyDetail?.plataformaActividad ?? "servicios"}
            onChange={(e) => handleSavePlataformaActividad(e.target.value)}
            className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
          >
            <option value="transporte">Transporte de pasajeros / entrega de bienes — 2.1%</option>
            <option value="hospedaje">Servicios de hospedaje — 4%</option>
            <option value="servicios">Enajenación de bienes / prestación de servicios — 1%</option>
          </select>
        </div>
      )}

      {/* ── Facturapi Setup + FIEL ── */}
      {activeCompany && (
        <>
        <div className="bg-cos-card border border-cos-line rounded-xl shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 border-b border-cos-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${isConnected ? "bg-cos-jade-tint" : "bg-cos-slate-tint"}`}>
                <Zap className={`h-4 w-4 ${isConnected ? "text-cos-jade-ink" : "text-cos-ink-soft"}`} />
              </div>
              <div>
                <h2 className="font-semibold text-sm">Facturapi — Timbrado CFDI</h2>
                <p className="text-xs text-cos-ink-soft">{activeCompany.razonSocial}</p>
              </div>
            </div>
            {isConnected && (
              <span className="flex items-center gap-1.5 text-xs bg-cos-jade-tint text-cos-jade-ink font-medium px-2.5 py-1 rounded-full">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Conectado
              </span>
            )}
          </div>

          <div className="px-6 py-5 space-y-5">
            {/* Live Facturapi pending steps banner */}
            {fpStatus && fpStatus.orgId && (fpStatus.pendingSteps?.length ?? 0) > 0 && (() => {
              const needsManifiesto = fpStatus.pendingSteps?.some(s => s.type === "manifiesto");
              const needsCert = fpStatus.pendingSteps?.some(s => s.type === "certificate");
              return (
                <div className="bg-cos-amber-tint border border-cos-amber-ink/20 rounded-lg p-4 text-sm">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-4 w-4 text-cos-amber-ink mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-cos-amber-ink mb-1.5">
                        Pasos pendientes para activar el timbrado en producción:
                      </p>
                      <ul className="list-disc list-inside space-y-1 text-cos-amber-ink text-xs">
                        {fpStatus.pendingSteps?.map((s, i) => (
                          <li key={i}>
                            <strong>{s.type}</strong> — {s.description}
                          </li>
                        ))}
                      </ul>

                      <div className="mt-3 space-y-2">
                        {needsCert && (
                          <p className="text-xs text-cos-amber-ink">
                            📄 <strong>CSD:</strong> súbelo desde el formulario de abajo &ldquo;Sube tu CSD para activar el timbrado&rdquo;.
                          </p>
                        )}
                        {needsManifiesto && (
                          <div className="text-xs text-cos-amber-ink">
                            <p className="mb-1">
                              ✍️ <strong>Carta Manifiesto:</strong> Facturapi requiere firmarla con tu e.firma directamente en su portal seguro (no se pueden enviar las llaves desde nuestra app).
                            </p>
                            <a
                              href="https://www.facturapi.io/manifiesto"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 mt-1 text-xs font-medium bg-cos-amber-tint text-white px-2.5 py-1.5 rounded hover:bg-cos-amber-tint"
                            >
                              Firmar Carta Manifiesto en Facturapi
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <p className="text-[10px] text-cos-amber-ink mt-1">
                              Necesitarás tu .cer, .key y contraseña de la e.firma.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Live Facturapi success badge */}
            {fpStatus && fpStatus.isProductionReady && (fpStatus.pendingSteps?.length ?? 0) === 0 && (
              <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-4 py-3 text-sm flex items-center gap-2 text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  ✓ Organización lista para producción. Puedes timbrar CFDIs.
                  {fpStatus.taxId && <span className="ml-2 font-mono text-xs text-cos-jade-ink">RFC: {fpStatus.taxId}</span>}
                </span>
              </div>
            )}

            {/* Status */}
            {isConnected ? (
              <div className="space-y-3">
                {/* Org info */}
                <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg p-4 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5">
                      {companyDetail?.facturapiOrgId && (
                        <div>
                          <span className="text-xs text-cos-ink-soft">Org ID</span>
                          <p className="font-mono text-xs">{companyDetail.facturapiOrgId}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-xs text-cos-ink-soft">API Key</span>
                        <div className="flex items-center gap-2">
                          <p className="font-mono text-xs">
                            {showKey
                              ? companyDetail?.facturapiApiKey
                              : companyDetail?.facturapiApiKey?.substring(0, 12) + "••••••••••••"}
                          </p>
                          <button onClick={() => setShowKey((v) => !v)}
                            className="text-cos-ink-soft hover:text-cos-ink">
                            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-cos-ink-soft">CSD</span>
                        <p className="text-xs font-medium">
                          {hasCsd ? (
                            <span className="text-cos-jade-ink">✓ Certificado guardado</span>
                          ) : (
                            <span className="text-cos-amber-ink">⚠ Sin CSD — configúralo en el onboarding</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <a href="https://app.facturapi.io" target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-cos-brand-ink hover:underline shrink-0">
                      Ver en Facturapi <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

                {/* Re-sync button */}
                <button onClick={handleAutoSetup} disabled={fpLoading}
                  className="flex items-center gap-2 text-sm px-4 py-2 border border-cos-line rounded-md hover:bg-cos-paper disabled:opacity-50">
                  {fpLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  Re-sincronizar datos legales y CSD
                </button>

                {/* Disconnect */}
                <button onClick={handleDisconnect} disabled={disconnectLoading}
                  className="flex items-center gap-2 text-sm text-cos-red-ink hover:text-cos-red-ink px-4 py-2 rounded-md hover:bg-cos-red-tint disabled:opacity-50">
                  {disconnectLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Desconectar Facturapi
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-lg p-4 text-sm text-cos-brand-ink">
                  <p className="font-semibold mb-1">Para timbrar CFDIs necesitas Facturapi</p>
                  <p>Facturapi actúa como PAC (Proveedor Autorizado de Certificación) ante el SAT. La organización se provisiona automáticamente al crear la empresa. Si tu empresa fue creada antes de configurar Facturapi, usa el botón &ldquo;Configurar Facturapi&rdquo; abajo para reintentarlo.</p>
                </div>

                {/* Option 1: CSD upload (the only thing that actually unlocks timbrado) */}
                <div className="border border-cos-line rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <FileKey2 className="h-4 w-4 text-cos-brand-ink" />
                    <h3 className="text-sm font-semibold">Opción 1 — Sube tu CSD para activar el timbrado</h3>
                    <span className="text-xs bg-cos-brand-tint text-cos-brand-ink px-2 py-0.5 rounded-full font-medium">Recomendada</span>
                  </div>
                  <p className="text-xs text-cos-ink-soft mb-3">
                    El Certificado de Sello Digital (CSD) lo emite el SAT. Una vez subido, generamos automáticamente tu clave live en Facturapi y podrás timbrar CFDIs.
                    {companyDetail?.facturapiOrgId && (
                      <span className="block mt-1 text-cos-jade-ink">
                        ✓ Organización en Facturapi ya creada · ID: <code className="font-mono">{companyDetail.facturapiOrgId}</code>
                      </span>
                    )}
                  </p>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">Certificado <code className="text-xs">.cer</code></label>
                      <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
                        <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                        <span className="text-cos-ink-soft truncate">{csdCerFile ? csdCerFile.name : "Seleccionar .cer"}</span>
                        <input type="file" accept=".cer" className="hidden"
                          onChange={(e) => setCsdCerFile(e.target.files?.[0] ?? null)} />
                      </label>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Llave privada <code className="text-xs">.key</code></label>
                      <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
                        <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                        <span className="text-cos-ink-soft truncate">{csdKeyFile ? csdKeyFile.name : "Seleccionar .key"}</span>
                        <input type="file" accept=".key" className="hidden"
                          onChange={(e) => setCsdKeyFile(e.target.files?.[0] ?? null)} />
                      </label>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Contraseña del CSD</label>
                      <input
                        type="password"
                        value={csdPassword}
                        onChange={(e) => setCsdPassword(e.target.value)}
                        placeholder="Contraseña de la llave privada"
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm"
                      />
                    </div>

                    {csdError && (
                      <p className="text-xs text-cos-red-ink">{csdError}</p>
                    )}
                    {csdSuccess && (
                      <p className="text-xs text-cos-jade-ink">{csdSuccess}</p>
                    )}

                    <button
                      onClick={handleCsdUpload}
                      disabled={csdSaving || !csdCerFile || !csdKeyFile || !csdPassword}
                      className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
                    >
                      {csdSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileKey2 className="h-4 w-4" />}
                      {csdSaving ? "Subiendo..." : "Subir CSD y activar timbrado"}
                    </button>
                  </div>
                </div>

                {/* Option 2: Manual */}
                <div className="border border-cos-line rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Key className="h-4 w-4 text-cos-ink-soft" />
                    <h3 className="text-sm font-semibold">Opción 2 — Pegar clave manualmente</h3>
                  </div>
                  <p className="text-xs text-cos-ink-soft mb-3">
                    Si ya tienes una organización en Facturapi, pega directamente su clave de API.
                  </p>
                  {!showManualKey ? (
                    <button onClick={() => setShowManualKey(true)}
                      className="flex items-center gap-2 text-sm px-4 py-2 border border-cos-line rounded-md hover:bg-cos-paper">
                      <Key className="h-4 w-4" />
                      Ingresar clave manualmente
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium mb-1">API Key de la organización <span className="text-cos-red-ink">*</span></label>
                        <div className="relative">
                          <input
                            type={showKey ? "text" : "password"}
                            value={manualKey}
                            onChange={(e) => setManualKey(e.target.value)}
                            placeholder="sk_live_... o sk_test_..."
                            className="w-full px-3 py-2 pr-10 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                          />
                          <button type="button" onClick={() => setShowKey((v) => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-cos-ink-soft">
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Org ID <span className="text-cos-ink-soft font-normal">(opcional)</span></label>
                        <input type="text" value={manualOrgId} onChange={(e) => setManualOrgId(e.target.value)}
                          placeholder="org_xxxxxxxxxxxxxxxxxx"
                          className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleSaveManualKey} disabled={savingKey || !manualKey.trim()}
                          className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50">
                          {savingKey && <Loader2 className="h-4 w-4 animate-spin" />}
                          Guardar
                        </button>
                        <button onClick={() => setShowManualKey(false)}
                          className="px-4 py-2 rounded-md text-sm border border-cos-line hover:bg-cos-paper">Cancelar</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Feedback messages */}
            {fpSuccess && (
              <div className="flex items-start gap-3 bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-4 py-3 text-sm text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                {fpSuccess}
              </div>
            )}
            {fpError && (
              <div className="flex items-start gap-3 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-4 py-3 text-sm text-cos-red-ink">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {fpError}
              </div>
            )}
          </div>
        </div>

        {/* ── e.firma / FIEL ── */}
        <div className="bg-cos-card rounded-xl border border-cos-line shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cos-amber-tint flex items-center justify-center shrink-0">
                <Shield className="h-5 w-5 text-cos-amber-ink" />
              </div>
              <div>
                <h2 className="font-semibold text-sm">e.firma / FIEL</h2>
                <p className="text-xs text-cos-ink-soft">Requerida para sincronizar CFDIs del SAT</p>
              </div>
            </div>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${fielBadge.clase}`}>
              {fielBadge.texto}
            </span>
          </div>

          <div className="px-5 py-4 space-y-4">
            {hasFiel ? (
              <div className="space-y-3">
                {fielEstado === "vencida" ? (
                  <div className="bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-4 py-3 text-sm text-cos-red-ink">
                    <p className="font-medium">e.firma vencida{fielVigenciaFmt ? ` el ${fielVigenciaFmt}` : ""} — la sincronización con el SAT está detenida</p>
                    <p className="text-xs mt-0.5">Renueva tu e.firma en el SAT y vuelve a subir los archivos .cer y .key para reanudar la descarga de CFDIs.</p>
                  </div>
                ) : fielEstado === "por_vencer" ? (
                  <div className="bg-cos-amber-tint border border-cos-amber-ink/20 rounded-lg px-4 py-3 text-sm text-cos-amber-ink">
                    <p className="font-medium">Tu e.firma vence{fielVigenciaFmt ? ` el ${fielVigenciaFmt}` : " pronto"}</p>
                    <p className="text-xs mt-0.5">Renuévala en el SAT y actualiza los archivos .cer y .key para que la sincronización de CFDIs no se interrumpa.</p>
                  </div>
                ) : (
                  <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-4 py-3 text-sm text-cos-jade-ink">
                    <p className="font-medium">e.firma almacenada de forma segura</p>
                    <p className="text-xs mt-0.5 text-cos-jade-ink">Usada para descargar CFDIs del SAT. Actualiza los archivos si tu e.firma expiró o cambió.</p>
                  </div>
                )}
                <p className="text-xs text-cos-ink-soft">Para actualizar, sube los nuevos archivos:</p>
              </div>
            ) : (
              <div className="bg-cos-amber-tint border border-cos-amber-ink/20 rounded-lg px-4 py-3 text-sm text-cos-amber-ink">
                <p className="font-medium mb-1">¿Qué es la e.firma?</p>
                <p>La Firma Electrónica Avanzada (FIEL) te permite autenticarte ante el SAT para descargar todos tus CFDIs emitidos y recibidos — necesario para calcular IVA acreditable con precisión.</p>
              </div>
            )}

            {/* Upload fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1.5">Certificado e.firma <code className="bg-cos-slate-tint px-1 rounded">.cer</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-cos-line border-dashed rounded-md text-xs cursor-pointer hover:bg-cos-paper transition-colors">
                  <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                  <span className="text-cos-ink-soft truncate">
                    {fielCerFile ? fielCerFile.name : "Seleccionar .cer"}
                  </span>
                  <input type="file" accept=".cer" className="hidden"
                    onChange={(e) => setFielCerFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">Llave privada <code className="bg-cos-slate-tint px-1 rounded">.key</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-cos-line border-dashed rounded-md text-xs cursor-pointer hover:bg-cos-paper transition-colors">
                  <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                  <span className="text-cos-ink-soft truncate">
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
                  className="w-full px-3 py-2 pr-10 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                />
                <button type="button" onClick={() => setShowFielPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-cos-ink-soft hover:text-cos-ink">
                  {showFielPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {fielSuccess && (
              <div className="flex items-start gap-2 bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-3 py-2 text-sm text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                {fielSuccess}
              </div>
            )}
            {fielError && (
              <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-3 py-2 text-sm text-cos-red-ink">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {fielError}
              </div>
            )}

            <button
              onClick={handleFielUpload}
              disabled={fielSaving || !fielCerFile || !fielKeyFile || !fielPassword}
              className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50 transition-colors"
            >
              {fielSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              {hasFiel ? "Actualizar e.firma" : "Guardar e.firma"}
            </button>
          </div>
        </div>
        {/* ── Apertura fiscal ── */}
        <div className="bg-cos-card rounded-xl border border-cos-line shadow-sm overflow-hidden mt-5">
          <div className="px-5 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
                <ClipboardCheck className="h-5 w-5 text-cos-brand-ink" />
              </div>
              <div className="min-w-0">
                <h2 className="font-semibold text-sm">Apertura fiscal</h2>
                <p className="text-xs text-cos-ink-soft">
                  Revisa y confirma el punto de partida: saldo a favor de IVA inicial, pérdidas por
                  amortizar, coeficiente de utilidad y obligaciones — con la fuente de cada dato.
                </p>
              </div>
            </div>
            <Link
              href="/empresa/apertura"
              className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-cos-brand-deep whitespace-nowrap shrink-0"
            >
              Revisar <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* ── Importar Declaraciones ── */}
        <div className="bg-cos-card rounded-xl border border-cos-line shadow-sm overflow-hidden mt-5">
          <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
                <Sparkles className="h-5 w-5 text-cos-brand-ink" />
              </div>
              <div>
                <h2 className="font-semibold text-sm">Importar Declaraciones</h2>
                <p className="text-xs text-cos-ink-soft">Sube acuses del SAT para cargar histórico de IVA e ISR</p>
              </div>
            </div>
          </div>

          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-cos-ink-soft">
              Sube los PDFs de tus <strong>acuses de declaración anual y/o mensual</strong> del SAT.
              El asistente los clasifica y extrae automáticamente los datos (IVA a favor, ISR, coeficiente de utilidad, etc.)
              para que el módulo de impuestos tenga la línea base correcta.
            </p>

            <label className="flex items-center gap-3 w-full px-4 py-3 border-2 border-dashed border-cos-brand-ink/15 rounded-md text-sm bg-cos-brand-tint/50 cursor-pointer hover:bg-cos-brand-tint transition-colors">
              {importParsing ? (
                <Loader2 className="h-4 w-4 text-cos-brand-ink shrink-0 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 text-cos-brand-ink shrink-0" />
              )}
              <span className="text-cos-ink-soft truncate flex-1">
                {importParsing ? "Procesando…" : "Seleccionar acuses PDF (puedes elegir varios)"}
              </span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                disabled={importParsing}
                className="hidden"
                onChange={(e) => {
                  handleImportUpload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>

            {/* Parsed docs list */}
            {importDocs.length > 0 && (
              <div className="space-y-1.5">
                {importDocs.map((d) => (
                  <div
                    key={d.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md border text-sm ${
                      d.type === "OTRO" ? "bg-cos-amber-tint border-cos-amber-ink/20" : "bg-cos-card border-cos-line"
                    }`}
                  >
                    <FileText className={`h-4 w-4 shrink-0 ${d.type === "OTRO" ? "text-cos-amber-ink" : "text-cos-brand-ink"}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{d.fileName}</p>
                      <p className="text-[10px] text-cos-ink-soft">
                        {DOC_LABEL[d.type]}
                        {d.type === "ACUSE_MENSUAL" && d.extracted?.acuseMensual?.periodoMes && (
                          <> · {String(d.extracted.acuseMensual.periodoMes).padStart(2, "0")}/{d.extracted.acuseMensual.periodoAnio}</>
                        )}
                        {d.type === "ACUSE_ANUAL" && d.extracted?.acuseAnual?.ejercicio && (
                          <> · Ejercicio {d.extracted.acuseAnual.ejercicio}</>
                        )}
                        {d.type === "ACUSE_ANUAL" && d.extracted?.acuseAnual?.coeficienteUtilidad != null && (
                          <> · CU: {d.extracted.acuseAnual.coeficienteUtilidad}</>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeImportDoc(d.id)}
                      className="p-1 rounded hover:bg-cos-paper text-cos-ink-soft shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {importError && (
              <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-3 py-2 text-sm text-cos-red-ink">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="text-xs">{importError}</span>
              </div>
            )}

            {importSuccess && (
              <div className="flex items-start gap-2 bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-3 py-2 text-sm text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="text-xs">{importSuccess}</span>
              </div>
            )}

            {importDocs.length > 0 && (
              <button
                onClick={handleImportSave}
                disabled={importSaving}
                className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {importSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {importSaving
                  ? "Importando…"
                  : `Importar ${importDocs.length} declaración${importDocs.length !== 1 ? "es" : ""}`}
              </button>
            )}
            {/* Historical declarations already imported */}
            {historicalDecs.length > 0 && (
              <div className="border-t border-cos-line pt-3 mt-1">
                <p className="text-xs font-medium text-cos-ink-soft mb-2">📄 Declaraciones importadas</p>
                <div className="space-y-1">
                  {historicalDecs.map(d => (
                    <div key={d.id} className="flex items-center justify-between text-xs bg-cos-card border border-cos-line rounded px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{d.periodo}</span>
                        <span className="text-cos-ink-soft">
                          {d.tipo === "DECLARACION_ANUAL" ? "Anual" : d.tipo === "IVA_MENSUAL" ? "IVA" : d.tipo === "ISR_PROVISIONAL" ? "ISR" : d.tipo}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-cos-ink-soft">
                        {d.isrCoeficienteUtilidad != null && (
                          <span>CU: <strong className="text-cos-ink">{d.isrCoeficienteUtilidad}</strong></span>
                        )}
                        {d.ivaPagar != null && d.ivaPagar > 0 && (
                          <span>IVA: <Money value={d.ivaPagar} weight={700} className="text-cos-red-ink" /></span>
                        )}
                        {d.ivaSaldoFavor != null && d.ivaSaldoFavor > 0 && (
                          <span>IVA favor: <Money value={d.ivaSaldoFavor} weight={700} className="text-cos-jade-ink" /></span>
                        )}
                        {d.isrPagar != null && d.isrPagar > 0 && (
                          <span>ISR: <Money value={d.isrPagar} weight={700} className="text-cos-red-ink" /></span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-cos-brand-tint text-cos-brand-ink font-medium text-[10px]">Importado</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Importar Contabilidad Electrónica (Anexo 24) ── */}
        <div className="bg-cos-card rounded-xl border border-cos-line shadow-sm overflow-hidden mt-5">
          <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint flex items-center justify-center shrink-0">
                <FileText className="h-5 w-5 text-cos-brand-ink" />
              </div>
              <div>
                <h2 className="font-semibold text-sm">Importar Contabilidad Electrónica</h2>
                <p className="text-xs text-cos-ink-soft">Arranca el catálogo de cuentas y los saldos iniciales desde el SAT (Anexo 24)</p>
              </div>
            </div>
          </div>

          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-cos-ink-soft">
              Sube el XML del <strong>Catálogo de Cuentas</strong> y de la última <strong>Balanza de Comprobación</strong>
              {" "}presentada al SAT. El catálogo crea el plan de cuentas de la empresa y la balanza genera los
              {" "}<strong>saldos iniciales</strong> (asiento de apertura). Es lo que hace que tu balanza y balance
              {" "}sean reales: los CFDIs por sí solos sólo dan el estado de resultados. Puedes descargar estos XML
              {" "}del portal del SAT (Contabilidad Electrónica) o exportarlos de tu sistema contable anterior.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1.5">Catálogo de Cuentas <code className="bg-cos-slate-tint px-1 rounded">.xml</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-cos-line border-dashed rounded-md text-xs cursor-pointer hover:bg-cos-paper transition-colors">
                  <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                  <span className="text-cos-ink-soft truncate">{ceCatalogoFile ? ceCatalogoFile.name : "Seleccionar catálogo"}</span>
                  <input type="file" accept=".xml,text/xml,application/xml" className="hidden"
                    onChange={(e) => setCeCatalogoFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">Balanza de Comprobación <code className="bg-cos-slate-tint px-1 rounded">.xml</code></label>
                <label className="flex items-center gap-2 w-full px-3 py-2.5 border border-cos-line border-dashed rounded-md text-xs cursor-pointer hover:bg-cos-paper transition-colors">
                  <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
                  <span className="text-cos-ink-soft truncate">{ceBalanzaFile ? ceBalanzaFile.name : "Seleccionar balanza"}</span>
                  <input type="file" accept=".xml,text/xml,application/xml" className="hidden"
                    onChange={(e) => setCeBalanzaFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5">Base de los saldos iniciales</label>
              <select
                value={ceUsar}
                onChange={(e) => setCeUsar(e.target.value === "inicial" ? "inicial" : "final")}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card"
              >
                <option value="final">Saldo final de la balanza (arranque del mes siguiente)</option>
                <option value="inicial">Saldo inicial de la balanza (arranque de ese mes)</option>
              </select>
            </div>

            {ceError && (
              <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-3 py-2 text-sm text-cos-red-ink">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="text-xs">{ceError}</span>
              </div>
            )}
            {ceSuccess && (
              <div className="flex items-start gap-2 bg-cos-jade-tint border border-cos-jade-ink/20 rounded-lg px-3 py-2 text-sm text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="text-xs">{ceSuccess}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleImportCeSyntage}
                disabled={ceSyntageSaving || ceSaving}
                className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {ceSyntageSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {ceSyntageSaving ? "Trayendo de Syntage…" : "Traer de Syntage automáticamente"}
              </button>
              <button
                onClick={handleImportCe}
                disabled={ceSaving || ceSyntageSaving || (!ceCatalogoFile && !ceBalanzaFile)}
                className="flex items-center gap-2 bg-cos-card border border-cos-line text-cos-ink px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper disabled:opacity-50"
              >
                {ceSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {ceSaving ? "Importando…" : "Importar XML manualmente"}
              </button>
            </div>
            <p className="text-xs text-cos-ink-soft">
              <strong>Traer de Syntage automáticamente</strong> descarga del SAT el catálogo y la última balanza con la
              {" "}e.firma ya conectada (sin subir archivos). Requiere plan Automatizado o superior. La subida manual de
              {" "}XML queda como alternativa.
            </p>
          </div>
        </div>

        </>
      )}
    </div>
  );
}
