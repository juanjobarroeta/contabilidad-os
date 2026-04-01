"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2, CheckCircle2, ChevronRight, Upload, Eye, EyeOff, Shield, FileKey2 } from "lucide-react";

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

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCsdPassword, setShowCsdPassword] = useState(false);
  const [showFielPassword, setShowFielPassword] = useState(false);

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
      <div className="bg-white rounded-xl shadow-sm border border-border w-full max-w-xl">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-border">
          <h1 className="text-xl font-bold text-foreground mb-1">Configura tu empresa</h1>
          <p className="text-sm text-muted-foreground">Ingresa los datos fiscales del SAT</p>

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
            {step > 1 && (
              <button
                type="button"
                onClick={() => { setError(""); setStep((s) => s - 1); }}
                className="px-4 py-2.5 rounded-md text-sm font-medium border border-border hover:bg-accent transition-colors"
              >
                Atrás
              </button>
            )}

            {step < 4 ? (
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
