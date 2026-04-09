"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Building2, Loader2, CheckCircle2, ChevronRight, Upload, Eye, EyeOff, Shield, FileKey2, Sparkles, AlertCircle, ArrowLeft } from "lucide-react";

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

const STEPS = [
  { id: 0, label: "Asistente IA",      icon: Sparkles },
  { id: 1, label: "Datos fiscales",    icon: Building2 },
  { id: 2, label: "Contacto",          icon: Building2 },
  { id: 3, label: "CSD",               icon: FileKey2 },
  { id: 4, label: "e.firma / FIEL",    icon: Shield },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Suspense-wrapped page root — useSearchParams() requires this boundary
// in Next.js 15 app router to avoid static-generation bailout.
export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Cargando…
        </div>
      }
    >
      <OnboardingPageInner />
    </Suspense>
  );
}

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // When launched from /configuracion/empresas we're in "add another company"
  // mode — adjust the header, back link target, and post-success redirect.
  const fromEmpresas = searchParams.get("from") === "empresas";
  const backHref = fromEmpresas ? "/configuracion/empresas" : null;
  const successHref = fromEmpresas ? "/configuracion/empresas" : "/dashboard";

  const [step, setStep] = useState(0); // start on AI step
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCsdPassword, setShowCsdPassword] = useState(false);
  const [showFielPassword, setShowFielPassword] = useState(false);

  // AI step state
  const [csfFile, setCsfFile] = useState<File | null>(null);
  const [aiParsing, setAiParsing] = useState(false);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiConfidenceNotes, setAiConfidenceNotes] = useState<string | null>(null);
  const [aiExtracted, setAiExtracted] = useState(false);

  // Form state
  const [fiscal, setFiscal] = useState({
    rfc: "", razonSocial: "", regimenFiscal: "", codigoPostal: "", domicilioFiscal: "",
  });
  const [contacto, setContacto] = useState({
    nombreComercial: "", email: "", telefono: "", actividadEconomica: "",
  });
  const [csd, setCsd] = useState({
    cerFile: null as File | null,
    keyFile: null as File | null,
    password: "",
  });
  const [fiel, setFiel] = useState({
    cerFile: null as File | null,
    keyFile: null as File | null,
    password: "",
  });

  // ── AI parse: upload CSF PDF, extract fields via /api/onboarding/parse-csf ──
  async function handleParseCsf() {
    if (!csfFile) {
      setError("Sube el archivo PDF primero");
      return;
    }
    setAiParsing(true);
    setError("");
    setAiWarnings([]);
    setAiConfidenceNotes(null);
    try {
      const form = new FormData();
      form.append("file", csfFile);
      const res = await fetch("/api/onboarding/parse-csf", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "No se pudo procesar el PDF");
      }
      const e = data.extracted as {
        rfc: string | null;
        razonSocial: string | null;
        nombre: string | null;
        primerApellido: string | null;
        segundoApellido: string | null;
        regimenFiscal: string | null;
        codigoPostal: string | null;
        calle: string | null;
        numExterior: string | null;
        numInterior: string | null;
        colonia: string | null;
        correo: string | null;
        telefono: string | null;
        actividadEconomica: string | null;
        tipoContribuyente: "PF" | "PM" | null;
        confidenceNotes: string | null;
      };

      // Build a reasonable domicilio string from the parts
      const domicilioParts = [
        e.calle && e.numExterior ? `${e.calle} ${e.numExterior}` : e.calle,
        e.numInterior ? `Int. ${e.numInterior}` : null,
        e.colonia ? `Col. ${e.colonia}` : null,
      ].filter(Boolean);
      const domicilioFiscal = domicilioParts.join(", ");

      setFiscal({
        rfc: e.rfc ?? "",
        razonSocial: e.razonSocial ?? "",
        regimenFiscal: e.regimenFiscal ?? "",
        codigoPostal: e.codigoPostal ?? "",
        domicilioFiscal,
      });
      setContacto({
        nombreComercial: e.tipoContribuyente === "PM" ? "" : "",
        email: e.correo ?? "",
        telefono: e.telefono ?? "",
        actividadEconomica: e.actividadEconomica ?? "",
      });
      setAiWarnings(data.warnings ?? []);
      setAiConfidenceNotes(e.confidenceNotes);
      setAiExtracted(true);
      // Jump forward to the first review step so the user sees the pre-filled data
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado al procesar el CSF");
    } finally {
      setAiParsing(false);
    }
  }

  function skipAi() {
    setError("");
    setStep(1);
  }

  function handleFiscalChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setFiscal((p) => ({ ...p, [name]: name === "rfc" ? value.toUpperCase() : value }));
  }

  function handleContactoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setContacto((p) => ({ ...p, [name]: value }));
  }

  function validateStep1() {
    const rfcRegex = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
    if (!rfcRegex.test(fiscal.rfc)) {
      setError("El RFC no tiene un formato válido (ej. XAXX010101000)");
      return false;
    }
    if (!fiscal.razonSocial.trim()) { setError("La Razón Social es requerida"); return false; }
    if (!fiscal.regimenFiscal) { setError("Selecciona un Régimen Fiscal"); return false; }
    if (fiscal.codigoPostal.length !== 5) { setError("El código postal debe tener 5 dígitos"); return false; }
    return true;
  }

  function nextStep() {
    setError("");
    if (step === 1 && !validateStep1()) return;
    setStep((s) => s + 1);
  }

  async function handleSubmit() {
    setError("");
    setLoading(true);
    try {
      // Encode CSD files if provided
      let csdCer: string | undefined;
      let csdKey: string | undefined;
      let fielCer: string | undefined;
      let fielKey: string | undefined;

      if (csd.cerFile) csdCer = await fileToBase64(csd.cerFile);
      if (csd.keyFile) csdKey = await fileToBase64(csd.keyFile);
      if (fiel.cerFile) fielCer = await fileToBase64(fiel.cerFile);
      if (fiel.keyFile) fielKey = await fileToBase64(fiel.keyFile);

      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fiscal,
          ...contacto,
          csdCer,
          csdKey,
          csdPassword: csd.password || undefined,
          fielCer,
          fielKey,
          fielPassword: fiel.password || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al crear la empresa");
      }

      router.push(successHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-border w-full max-w-xl">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-border">
          {backHref && (
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Volver a Empresas
            </Link>
          )}
          <h1 className="text-xl font-bold text-foreground mb-1">
            {fromEmpresas ? "Agregar nueva empresa" : "Configura tu empresa"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {fromEmpresas
              ? "Se agregará a tu despacho automáticamente"
              : "Ingresa los datos fiscales del SAT"}
          </p>

          {/* Step indicators */}
          <div className="flex items-center gap-1 mt-5">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1 flex-1">
                <div className="flex flex-col items-center flex-1">
                  <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                    step > s.id ? "bg-green-500 text-white" :
                    step === s.id ? "bg-primary text-primary-foreground" :
                    "bg-gray-100 text-muted-foreground"
                  }`}>
                    {step > s.id ? <CheckCircle2 className="h-4 w-4" /> : s.id}
                  </div>
                  <span className={`text-xs mt-1 text-center leading-tight ${step === s.id ? "text-primary font-medium" : "text-muted-foreground"}`}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-px flex-1 mb-4 ${step > s.id ? "bg-green-400" : "bg-gray-200"}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-8 py-6 space-y-5">

          {/* ── STEP 0: Asistente IA ── */}
          {step === 0 && (
            <>
              <div className="bg-gradient-to-br from-indigo-50 via-purple-50 to-indigo-50 border border-indigo-200 rounded-lg p-5">
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center shrink-0">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-indigo-900">Llena el formulario automáticamente</h3>
                    <p className="text-xs text-indigo-800 mt-0.5">
                      Sube tu <strong>Constancia de Situación Fiscal</strong> (PDF del SAT) y el asistente extrae los datos.
                      Podrás revisarlos y corregirlos antes de continuar.
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-3 w-full px-4 py-3 border-2 border-dashed border-indigo-300 rounded-md text-sm bg-white cursor-pointer hover:bg-indigo-50/50 transition-colors">
                  <Upload className="h-4 w-4 text-indigo-600 shrink-0" />
                  <span className={`truncate flex-1 ${csfFile ? "text-foreground" : "text-muted-foreground"}`}>
                    {csfFile ? csfFile.name : "Seleccionar archivo PDF de tu CSF"}
                  </span>
                  {csfFile && (
                    <span className="text-xs text-muted-foreground">
                      {(csfFile.size / 1024).toFixed(0)} KB
                    </span>
                  )}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setCsfFile(f);
                      setError("");
                      setAiWarnings([]);
                    }}
                  />
                </label>
                <p className="text-[10px] text-indigo-700 mt-2">
                  🔒 El PDF se procesa con Claude (Anthropic) y no se almacena. Los datos fiscales son confidenciales.
                </p>
              </div>

              <div className="text-center text-xs text-muted-foreground">
                ¿No tienes tu CSF a la mano?{" "}
                <button
                  type="button"
                  onClick={skipAi}
                  className="text-primary hover:underline font-medium"
                >
                  Llénalo manualmente
                </button>
              </div>
            </>
          )}

          {/* AI warnings banner — visible in step 1 after AI extraction */}
          {step === 1 && aiExtracted && (aiWarnings.length > 0 || aiConfidenceNotes) && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex-1 space-y-1">
                  <p className="font-semibold">Revisa los datos extraídos</p>
                  {aiWarnings.map((w, i) => (
                    <p key={i} className="text-xs">• {w}</p>
                  ))}
                  {aiConfidenceNotes && <p className="text-xs italic">{aiConfidenceNotes}</p>}
                </div>
              </div>
            </div>
          )}
          {step === 1 && aiExtracted && aiWarnings.length === 0 && !aiConfidenceNotes && (
            <div className="bg-green-50 border border-green-200 rounded-md px-4 py-3 text-sm text-green-800 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Datos extraídos del CSF. Revisa y corrige si es necesario.
            </div>
          )}

          {/* ── STEP 1: Datos Fiscales ── */}
          {step === 1 && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1.5">RFC <span className="text-red-500">*</span></label>
                <input
                  type="text" name="rfc" value={fiscal.rfc} onChange={handleFiscalChange}
                  placeholder="XAXX010101000" maxLength={13} required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 uppercase"
                />
                <p className="text-xs text-muted-foreground mt-1">12 caracteres personas morales · 13 personas físicas</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Razón Social <span className="text-red-500">*</span></label>
                <input
                  type="text" name="razonSocial" value={fiscal.razonSocial} onChange={handleFiscalChange}
                  placeholder="Mi Empresa SA de CV" required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-xs text-muted-foreground mt-1">Tal como aparece en la Constancia de Situación Fiscal</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Régimen Fiscal <span className="text-red-500">*</span></label>
                <select
                  name="regimenFiscal" value={fiscal.regimenFiscal} onChange={handleFiscalChange} required
                  className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white"
                >
                  <option value="">Selecciona un régimen...</option>
                  {REGIMENES_FISCALES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Código Postal <span className="text-red-500">*</span></label>
                  <input
                    type="text" name="codigoPostal" value={fiscal.codigoPostal} onChange={handleFiscalChange}
                    placeholder="06600" maxLength={5} pattern="[0-9]{5}" required
                    className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">Domicilio Fiscal <span className="text-muted-foreground font-normal text-xs">(opcional)</span></label>
                  <input
                    type="text" name="domicilioFiscal" value={fiscal.domicilioFiscal} onChange={handleFiscalChange}
                    placeholder="Calle, Número, Colonia"
                    className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
            </>
          )}

          {/* ── STEP 2: Contacto ── */}
          {step === 2 && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1.5">Nombre Comercial <span className="text-muted-foreground font-normal text-xs">(opcional)</span></label>
                <input
                  type="text" name="nombreComercial" value={contacto.nombreComercial} onChange={handleContactoChange}
                  placeholder="Nombre que aparece en facturas y documentos"
                  className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Correo electrónico</label>
                  <input
                    type="email" name="email" value={contacto.email} onChange={handleContactoChange}
                    placeholder="contabilidad@empresa.com"
                    className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">Teléfono</label>
                  <input
                    type="tel" name="telefono" value={contacto.telefono} onChange={handleContactoChange}
                    placeholder="55 1234 5678"
                    className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Actividad Económica <span className="text-muted-foreground font-normal text-xs">(opcional)</span></label>
                <input
                  type="text" name="actividadEconomica" value={contacto.actividadEconomica} onChange={handleContactoChange}
                  placeholder="ej. Servicios de consultoría empresarial"
                  className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </>
          )}

          {/* ── STEP 3: CSD ── */}
          {step === 3 && (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-800">
                <p className="font-semibold mb-1">¿Qué es el CSD?</p>
                <p>El Certificado de Sello Digital (CSD) es requerido para <strong>timbrar CFDIs</strong>. Lo emite el SAT y consta de un archivo <code>.cer</code>, un <code>.key</code> y una contraseña.</p>
                <p className="mt-1 text-blue-600 text-xs">Puedes omitir este paso y configurarlo después desde Mi Empresa.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Certificado CSD <code className="text-xs bg-gray-100 px-1 rounded">.cer</code></label>
                <label className="flex items-center gap-3 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-sm cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {csd.cerFile ? csd.cerFile.name : "Seleccionar archivo .cer"}
                  </span>
                  <input type="file" accept=".cer" className="hidden"
                    onChange={(e) => setCsd((p) => ({ ...p, cerFile: e.target.files?.[0] ?? null }))} />
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Llave privada CSD <code className="text-xs bg-gray-100 px-1 rounded">.key</code></label>
                <label className="flex items-center gap-3 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-sm cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {csd.keyFile ? csd.keyFile.name : "Seleccionar archivo .key"}
                  </span>
                  <input type="file" accept=".key" className="hidden"
                    onChange={(e) => setCsd((p) => ({ ...p, keyFile: e.target.files?.[0] ?? null }))} />
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Contraseña del CSD</label>
                <div className="relative">
                  <input
                    type={showCsdPassword ? "text" : "password"}
                    value={csd.password}
                    onChange={(e) => setCsd((p) => ({ ...p, password: e.target.value }))}
                    placeholder="Contraseña de la llave privada"
                    className="w-full px-3 py-2 pr-10 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button type="button" onClick={() => setShowCsdPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showCsdPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ── STEP 4: e.firma / FIEL ── */}
          {step === 4 && (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold mb-1">¿Qué es la e.firma / FIEL?</p>
                <p>La Firma Electrónica Avanzada es requerida para <strong>presentar declaraciones fiscales</strong> ante el SAT (IVA, ISR, DIOT). También consta de un <code>.cer</code>, un <code>.key</code> y contraseña.</p>
                <p className="mt-1 text-amber-600 text-xs">Puedes omitir este paso y configurarlo después desde Mi Empresa.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Certificado e.firma <code className="text-xs bg-gray-100 px-1 rounded">.cer</code></label>
                <label className="flex items-center gap-3 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-sm cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {fiel.cerFile ? fiel.cerFile.name : "Seleccionar archivo .cer"}
                  </span>
                  <input type="file" accept=".cer" className="hidden"
                    onChange={(e) => setFiel((p) => ({ ...p, cerFile: e.target.files?.[0] ?? null }))} />
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Llave privada e.firma <code className="text-xs bg-gray-100 px-1 rounded">.key</code></label>
                <label className="flex items-center gap-3 w-full px-3 py-2.5 border border-border border-dashed rounded-md text-sm cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground truncate">
                    {fiel.keyFile ? fiel.keyFile.name : "Seleccionar archivo .key"}
                  </span>
                  <input type="file" accept=".key" className="hidden"
                    onChange={(e) => setFiel((p) => ({ ...p, keyFile: e.target.files?.[0] ?? null }))} />
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Contraseña de la e.firma</label>
                <div className="relative">
                  <input
                    type={showFielPassword ? "text" : "password"}
                    value={fiel.password}
                    onChange={(e) => setFiel((p) => ({ ...p, password: e.target.value }))}
                    placeholder="Contraseña de la llave privada"
                    className="w-full px-3 py-2 pr-10 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button type="button" onClick={() => setShowFielPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showFielPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Navigation */}
          <div className="flex gap-3 pt-2">
            {step > 0 && step !== 1 && (
              <button
                type="button"
                onClick={() => { setError(""); setStep((s) => s - 1); }}
                className="px-4 py-2.5 rounded-md text-sm font-medium border border-border hover:bg-accent transition-colors"
              >
                Atrás
              </button>
            )}

            {step === 0 ? (
              <button
                type="button"
                onClick={handleParseCsf}
                disabled={!csfFile || aiParsing}
                className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {aiParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {aiParsing ? "Analizando PDF..." : "Extraer datos con IA"}
              </button>
            ) : step < 4 ? (
              <button
                type="button"
                onClick={nextStep}
                className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Continuar <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {loading ? "Creando empresa..." : "Finalizar configuración"}
              </button>
            )}

            {/* Skip CSD/FIEL steps */}
            {(step === 3 || step === 4) && (
              <button
                type="button"
                onClick={() => step === 4 ? handleSubmit() : setStep((s) => s + 1)}
                disabled={loading}
                className="px-4 py-2.5 rounded-md text-sm text-muted-foreground border border-border hover:bg-accent transition-colors"
              >
                Omitir
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
