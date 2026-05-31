"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Building2, Loader2, CheckCircle2, ChevronRight, Upload, Eye, EyeOff, Shield, FileKey2, Sparkles, AlertCircle, ArrowLeft, FileText, X, ListChecks, RefreshCw, CreditCard } from "lucide-react";

// ── Types for the multi-document onboarding package ───────────────────────
type DocType = "CSF" | "TARJETA_IMSS" | "ACUSE_ANUAL" | "ACUSE_MENSUAL" | "OTRO";

type ParsedDoc = {
  id: string;
  fileName: string;
  type: DocType;
  extracted: {
    csf: {
      rfc: string | null;
      tipoContribuyente: "PF" | "PM" | null;
      razonSocial: string | null;
      nombre: string | null;
      primerApellido: string | null;
      segundoApellido: string | null;
      regimenFiscal: string | null;
      regimenes: { code: string; label: string; since: string | null }[];
      codigoPostal: string | null;
      calle: string | null;
      numExterior: string | null;
      numInterior: string | null;
      colonia: string | null;
      correo: string | null;
      telefono: string | null;
      actividadEconomica: string | null;
      obligaciones: string[] | null;
      confidenceNotes: string | null;
    } | null;
    imss: {
      registroPatronal: string | null;
      clase: string | null;
      fraccion: string | null;
      prima: number | null;
    } | null;
    acuseAnual: {
      ejercicio: number | null;
      coeficienteUtilidad: number | null;
      utilidadFiscal: number | null;
      isrCausado: number | null;
      isrAPagar: number | null;
      lineaCaptura: string | null;
      fechaPresentacion: string | null;
    } | null;
    acuseMensual: {
      periodoMes: number | null;
      periodoAnio: number | null;
      tipoImpuesto: "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null;
      tipoPago: "PROVISIONAL" | "DEFINITIVO" | "NORMAL" | "COMPLEMENTARIA" | null;
      ivaAPagar: number | null;
      ivaAFavor: number | null;
      isrAPagar: number | null;
      lineaCaptura: string | null;
      fechaPresentacion: string | null;
    } | null;
  };
  warnings: string[];
};

const DOC_LABEL: Record<DocType, string> = {
  CSF: "Constancia de Situación Fiscal",
  TARJETA_IMSS: "Tarjeta Identificación Patronal IMSS",
  ACUSE_ANUAL: "Acuse Declaración Anual",
  ACUSE_MENSUAL: "Acuse Declaración Mensual",
  OTRO: "Documento no reconocido",
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

const STEPS = [
  { id: 0, label: "Asistente IA",      icon: Sparkles },
  { id: 1, label: "Datos fiscales",    icon: Building2 },
  { id: 2, label: "Revisión",          icon: ListChecks },
  { id: 3, label: "Sincronización",    icon: RefreshCw },
  { id: 4, label: "Plan",              icon: CreditCard },
  { id: 5, label: "Contacto",          icon: Building2 },
  { id: 6, label: "CSD",               icon: FileKey2 },
  { id: 7, label: "e.firma / FIEL",    icon: Shield },
];

const LAST_STEP = 7;

// 3-tier plan cards — UI/trial only for now (no billing). Prices MXN/mes.
const PLANS = [
  {
    id: "BASICO",
    name: "Básico",
    price: "$499",
    blurb: "1 empresa",
    features: ["Sincronización SAT", "Consultas y reportes", "Declaraciones"],
  },
  {
    id: "PROFESIONAL",
    name: "Profesional",
    price: "$999",
    blurb: "Para tu negocio",
    features: ["Todo lo de Básico", "WhatsApp + alertas", "Conciliación bancaria", "Complementos de pago"],
    highlight: true,
  },
  {
    id: "DESPACHO",
    name: "Despacho",
    price: "$399",
    blurb: "por empresa · contadores",
    features: ["Multiempresa", "Todo lo Profesional", "Gestión de clientes"],
  },
];

// How far back to pull CFDIs on the first sync.
const BACKFILL_OPTIONS = [
  { years: 5, label: "Últimos 5 años", desc: "Máximo histórico permitido por el SAT. Recomendado." },
  { years: 1, label: "Último año", desc: "Más rápido: solo los últimos 12 meses." },
  { years: 0, label: "No sincronizar ahora", desc: "Empieza sin historial; puedes sincronizar después." },
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

// Safe relative path allowlist — we only honor internal paths in returnTo to
// prevent open redirects.
function safeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null; // protocol-relative
  return raw;
}

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // When launched from an "add another company" entry point we adjust the
  // header, back link target, and post-success redirect.
  const fromEmpresas = searchParams.get("from") === "empresas";
  const explicitReturn = safeReturnTo(searchParams.get("returnTo"));
  // returnTo (if passed) beats fromEmpresas default; both beat first-run default
  const backHref =
    explicitReturn ?? (fromEmpresas ? "/configuracion/empresas" : null);
  const successHref =
    explicitReturn ?? (fromEmpresas ? "/configuracion/empresas" : "/dashboard");

  const [step, setStep] = useState(0); // start on AI step
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCsdPassword, setShowCsdPassword] = useState(false);
  const [showFielPassword, setShowFielPassword] = useState(false);

  // AI step state — multi-document onboarding package
  const [parsedDocs, setParsedDocs] = useState<ParsedDoc[]>([]);
  const [aiParsing, setAiParsing] = useState(false);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiConfidenceNotes, setAiConfidenceNotes] = useState<string | null>(null);
  const [aiExtracted, setAiExtracted] = useState(false);
  const [detectedRegimenes, setDetectedRegimenes] = useState<{ code: string; label: string; since: string | null }[]>([]);
  // Which detected régimenes the user includes for this company (codes). The
  // primary is fiscal.regimenFiscal below.
  const [selectedRegimenes, setSelectedRegimenes] = useState<string[]>([]);

  // SAT historical backfill depth (years) + selected plan tier.
  const [satBackfillYears, setSatBackfillYears] = useState(5);
  const [plan, setPlan] = useState("PROFESIONAL");

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

  // ── AI parse: upload N PDFs, classify + extract each via /api/onboarding/parse-document ──
  async function handleUploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAiParsing(true);
    setError("");
    try {
      const results: ParsedDoc[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/onboarding/parse-document", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          setError(`${file.name}: ${data.error ?? "No se pudo procesar"}`);
          continue;
        }
        results.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fileName: file.name,
          type: data.type as DocType,
          extracted: data.extracted,
          warnings: data.warnings ?? [],
        });
      }
      setParsedDocs((prev) => [...prev, ...results]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado al procesar documentos");
    } finally {
      setAiParsing(false);
    }
  }

  function removeParsedDoc(id: string) {
    setParsedDocs((prev) => prev.filter((d) => d.id !== id));
  }

  // Apply aggregated docs → form state, then go to review step
  function applyAndContinue() {
    const csfDoc = parsedDocs.find((d) => d.type === "CSF" && d.extracted.csf);
    if (!csfDoc || !csfDoc.extracted.csf) {
      setError("Necesitas subir al menos una Constancia de Situación Fiscal (CSF)");
      return;
    }
    const c = csfDoc.extracted.csf;

    const domicilioParts = [
      c.calle && c.numExterior ? `${c.calle} ${c.numExterior}` : c.calle,
      c.numInterior ? `Int. ${c.numInterior}` : null,
      c.colonia ? `Col. ${c.colonia}` : null,
    ].filter(Boolean);

    setFiscal({
      rfc: c.rfc ?? "",
      razonSocial: c.razonSocial ?? "",
      regimenFiscal: c.regimenFiscal ?? "",
      codigoPostal: c.codigoPostal ?? "",
      domicilioFiscal: domicilioParts.join(", "),
    });
    setContacto({
      nombreComercial: "",
      email: c.correo ?? "",
      telefono: c.telefono ?? "",
      actividadEconomica: c.actividadEconomica ?? "",
    });
    const regs = c.regimenes ?? [];
    setDetectedRegimenes(regs);
    // Include every detected régimen by default; the company has all of them.
    setSelectedRegimenes(regs.map((r) => r.code));
    // Default the primary: parser's pick if valid, else the first detected.
    if (!c.regimenFiscal && regs.length > 0) {
      setFiscal((p) => ({ ...p, regimenFiscal: regs[0].code }));
    }

    // Aggregate all warnings across all docs
    const allWarnings = parsedDocs.flatMap((d) =>
      d.warnings.map((w) => `${DOC_LABEL[d.type]}: ${w}`)
    );
    setAiWarnings(allWarnings);
    setAiConfidenceNotes(c.confidenceNotes);
    setAiExtracted(true);
    setError("");
    setStep(1);
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

  // Toggle a detected régimen on/off for this company. Keep the primary valid:
  // never let the user un-check the primary without picking a new one.
  function toggleRegimen(code: string) {
    setSelectedRegimenes((prev) => {
      const has = prev.includes(code);
      const next = has ? prev.filter((c) => c !== code) : [...prev, code];
      if (has && fiscal.regimenFiscal === code) {
        setFiscal((p) => ({ ...p, regimenFiscal: next[0] ?? "" }));
      }
      if (!has && !fiscal.regimenFiscal) {
        setFiscal((p) => ({ ...p, regimenFiscal: code }));
      }
      return next;
    });
  }

  function validateStep1() {
    const rfcRegex = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
    if (!rfcRegex.test(fiscal.rfc)) {
      setError("El RFC no tiene un formato válido (ej. XAXX010101000)");
      return false;
    }
    if (!fiscal.razonSocial.trim()) { setError("La Razón Social es requerida"); return false; }
    if (!fiscal.regimenFiscal) { setError("Selecciona un Régimen Fiscal principal"); return false; }
    if (detectedRegimenes.length > 0) {
      if (selectedRegimenes.length === 0) { setError("Incluye al menos un régimen"); return false; }
      if (!selectedRegimenes.includes(fiscal.regimenFiscal)) {
        setError("El régimen principal debe estar entre los incluidos");
        return false;
      }
    }
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

      // Earliest régimen start date from the CSF — used server-side as the
      // lower bound for the historical SAT backfill (we never ask SAT for
      // CFDIs before the company existed).
      const csfDoc = parsedDocs.find((d) => d.type === "CSF" && d.extracted.csf);
      const regimenSinces = (csfDoc?.extracted.csf?.regimenes ?? [])
        .map((r) => r.since)
        .filter((s): s is string => !!s && !isNaN(new Date(s).getTime()))
        .sort();
      const fechaInicioRegimen = regimenSinces[0] ?? undefined;

      // Full régimen list detected on the CSF — persisted as CompanyRegimen rows
      // alongside the chosen primary (fiscal.regimenFiscal).
      // Only the régimenes the user kept checked (fall back to detected list if
      // selection state is empty, e.g. manual entry).
      const detected = (csfDoc?.extracted.csf?.regimenes ?? []).filter((r) => r.code);
      const regimenes =
        selectedRegimenes.length > 0
          ? detected.filter((r) => selectedRegimenes.includes(r.code))
          : detected;

      // The CSF's explicit obligaciones — authoritative source for which
      // obligations the SAT registered for this taxpayer.
      const csfObligaciones = csfDoc?.extracted.csf?.obligaciones ?? [];

      // Build onboardingPackage from parsed docs (IMSS, anual, mensuales)
      const imssDoc = parsedDocs.find((d) => d.type === "TARJETA_IMSS");
      const anualDoc = parsedDocs.find((d) => d.type === "ACUSE_ANUAL");
      const mensualDocs = parsedDocs.filter((d) => d.type === "ACUSE_MENSUAL");
      const onboardingPackage = (imssDoc || anualDoc || mensualDocs.length > 0)
        ? {
            imss: imssDoc?.extracted.imss ?? null,
            acuseAnual: anualDoc?.extracted.acuseAnual ?? null,
            acusesMensuales: mensualDocs.map((d) => d.extracted.acuseMensual).filter(Boolean),
          }
        : undefined;

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
          fechaInicioRegimen,
          regimenes,
          csfObligaciones,
          satBackfillYears,
          plan,
          onboardingPackage,
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

  // ── Derived data for the Revisión step ──────────────────────────────────────
  const csfObligaciones =
    parsedDocs.find((d) => d.type === "CSF")?.extracted.csf?.obligaciones ?? [];
  const anualDocReview =
    parsedDocs.find((d) => d.type === "ACUSE_ANUAL")?.extracted.acuseAnual ?? null;
  const mensualesReview = parsedDocs
    .filter((d) => d.type === "ACUSE_MENSUAL")
    .map((d) => d.extracted.acuseMensual)
    .filter((m): m is NonNullable<typeof m> => !!m);
  const money = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

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

          {/* Step indicators — icon dots + connectors, with a single active-step caption */}
          <div className="flex items-center mt-5">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const done = step > s.id;
              const active = step === s.id;
              return (
                <div key={s.id} className="flex items-center flex-1 last:flex-none">
                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                      done
                        ? "bg-green-500 text-white"
                        : active
                        ? "bg-primary text-primary-foreground ring-4 ring-primary/15"
                        : "bg-gray-100 text-muted-foreground"
                    }`}
                  >
                    {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`h-px flex-1 mx-1.5 ${done ? "bg-green-400" : "bg-gray-200"}`} />
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-center mt-3">
            <span className="text-muted-foreground">Paso {step + 1} de {STEPS.length} · </span>
            <span className="font-medium text-primary">{STEPS[step]?.label}</span>
          </p>
        </div>

        <div className="px-8 py-6 space-y-5">

          {/* ── STEP 0: Asistente IA (multi-documento) ── */}
          {step === 0 && (
            <>
              <div className="bg-gradient-to-br from-indigo-50 via-purple-50 to-indigo-50 border border-indigo-200 rounded-lg p-5">
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center shrink-0">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-indigo-900">Onboarding asistido con IA</h3>
                    <p className="text-xs text-indigo-800 mt-0.5">
                      Sube todos los documentos relevantes en un solo paso. El asistente clasifica y extrae los datos automáticamente.
                    </p>
                    <ul className="text-[11px] text-indigo-800 mt-2 space-y-0.5 list-disc list-inside">
                      <li><strong>CSF</strong> (obligatorio) — datos fiscales base</li>
                      <li><strong>Tarjeta IMSS</strong> — registro patronal para nómina</li>
                      <li><strong>Acuse Anual</strong> — coeficiente de utilidad</li>
                      <li><strong>Acuses Mensuales</strong> — histórico si onboardeas a mitad de año</li>
                    </ul>
                  </div>
                </div>
                <label className="flex items-center gap-3 w-full px-4 py-3 border-2 border-dashed border-indigo-300 rounded-md text-sm bg-white cursor-pointer hover:bg-indigo-50/50 transition-colors">
                  {aiParsing ? (
                    <Loader2 className="h-4 w-4 text-indigo-600 shrink-0 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4 text-indigo-600 shrink-0" />
                  )}
                  <span className="truncate flex-1 text-muted-foreground">
                    {aiParsing ? "Procesando documentos..." : "Agregar archivos PDF (puedes seleccionar varios)"}
                  </span>
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    disabled={aiParsing}
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <p className="text-[10px] text-indigo-700 mt-2">
                  🔒 Los PDFs se procesan con Claude (Anthropic) y no se almacenan.
                </p>
              </div>

              {/* List of parsed docs */}
              {parsedDocs.length > 0 && (
                <div className="space-y-2">
                  {parsedDocs.map((d) => (
                    <div
                      key={d.id}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-md border text-sm ${
                        d.type === "OTRO"
                          ? "bg-amber-50 border-amber-200"
                          : "bg-white border-border"
                      }`}
                    >
                      <FileText
                        className={`h-4 w-4 shrink-0 ${
                          d.type === "OTRO" ? "text-amber-600" : "text-primary"
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{d.fileName}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {DOC_LABEL[d.type]}
                          {d.type === "ACUSE_MENSUAL" && d.extracted.acuseMensual?.periodoMes && (
                            <> · {String(d.extracted.acuseMensual.periodoMes).padStart(2, "0")}/{d.extracted.acuseMensual.periodoAnio}</>
                          )}
                          {d.type === "ACUSE_ANUAL" && d.extracted.acuseAnual?.ejercicio && (
                            <> · Ejercicio {d.extracted.acuseAnual.ejercicio}</>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeParsedDoc(d.id)}
                        className="p-1 rounded hover:bg-accent text-muted-foreground shrink-0"
                        title="Quitar"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {parsedDocs.length > 0 && (
                <button
                  type="button"
                  onClick={applyAndContinue}
                  className="w-full bg-indigo-600 text-white px-4 py-2.5 rounded-md text-sm font-medium hover:bg-indigo-700 flex items-center justify-center gap-2"
                >
                  <Sparkles className="h-4 w-4" />
                  Aplicar y continuar ({parsedDocs.length} {parsedDocs.length === 1 ? "documento" : "documentos"})
                </button>
              )}

              <div className="text-center text-xs text-muted-foreground">
                ¿No tienes los documentos a la mano?{" "}
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

          {/* Régimen confirmation — confirm ALL detected régimenes, mark the primary */}
          {step === 1 && detectedRegimenes.length >= 1 && (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm">
              <p className="font-semibold text-blue-900 text-xs mb-1">
                Detectamos {detectedRegimenes.length} {detectedRegimenes.length === 1 ? "régimen" : "regímenes"} en tu CSF
              </p>
              <p className="text-[11px] text-blue-800/80 mb-2">
                Confirma cuáles aplican y marca el principal (el que usas para facturar). Generaremos las obligaciones de todos los incluidos.
              </p>
              <div className="space-y-1.5">
                {detectedRegimenes.map((r) => {
                  const included = selectedRegimenes.includes(r.code);
                  const isPrimary = fiscal.regimenFiscal === r.code;
                  return (
                    <div
                      key={r.code}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded border ${
                        included ? "bg-white border-blue-300" : "bg-white/40 border-transparent opacity-60"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleRegimen(r.code)}
                        className="shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs"><span className="font-mono font-semibold">{r.code}</span> · {r.label}</p>
                        {r.since && <p className="text-[10px] text-muted-foreground">Desde {r.since}</p>}
                      </div>
                      <button
                        type="button"
                        disabled={!included}
                        onClick={() => setFiscal((p) => ({ ...p, regimenFiscal: r.code }))}
                        className={`text-[10px] px-2 py-1 rounded-full border shrink-0 transition-colors ${
                          isPrimary
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white text-blue-700 border-blue-300 hover:bg-blue-100 disabled:opacity-40"
                        }`}
                      >
                        {isPrimary ? "Principal ✓" : "Hacer principal"}
                      </button>
                    </div>
                  );
                })}
              </div>
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
              {detectedRegimenes.length === 0 && (
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
              )}
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

          {/* ── STEP 2: Revisión (obligaciones + declaraciones) ── */}
          {step === 2 && (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-md px-4 py-3 text-sm text-slate-700">
                Revisa lo que detectamos en tus documentos. Confirmamos los regímenes, las obligaciones de tu CSF y los datos de tus declaraciones.
              </div>

              {/* Régimenes incluidos */}
              <div>
                <p className="text-sm font-semibold mb-2">Regímenes</p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedRegimenes.length === 0 && (
                    <span className="text-xs text-muted-foreground">{fiscal.regimenFiscal || "—"}</span>
                  )}
                  {selectedRegimenes.map((code) => {
                    const r = detectedRegimenes.find((x) => x.code === code);
                    return (
                      <span key={code} className={`text-xs px-2 py-1 rounded-full border ${
                        fiscal.regimenFiscal === code ? "bg-blue-600 text-white border-blue-600" : "bg-white border-slate-300"
                      }`}>
                        {code}{r ? ` · ${r.label}` : ""}{fiscal.regimenFiscal === code ? " (principal)" : ""}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Obligaciones detectadas en el CSF */}
              <div>
                <p className="text-sm font-semibold mb-2">Obligaciones fiscales</p>
                {csfObligaciones.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No se detectaron obligaciones en el CSF. Se generarán a partir de tus regímenes.</p>
                ) : (
                  <ul className="space-y-1">
                    {csfObligaciones.map((o, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 mt-0.5" />
                        <span>{o}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Declaraciones (acuses) */}
              {(anualDocReview || mensualesReview.length > 0) && (
                <div>
                  <p className="text-sm font-semibold mb-2">Declaraciones cargadas</p>
                  {anualDocReview && (
                    <div className="border border-slate-200 rounded-md p-3 mb-2 text-xs space-y-1">
                      <p className="font-medium">Declaración anual {anualDocReview.ejercicio ?? ""}</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                        <span>Coeficiente de utilidad:</span><span className="text-foreground">{anualDocReview.coeficienteUtilidad ?? "—"}</span>
                        <span>Utilidad fiscal:</span><span className="text-foreground">{money(anualDocReview.utilidadFiscal)}</span>
                        <span>ISR a pagar:</span><span className="text-foreground">{money(anualDocReview.isrAPagar)}</span>
                      </div>
                    </div>
                  )}
                  {mensualesReview.map((m, i) => (
                    <div key={i} className="border border-slate-200 rounded-md p-3 mb-2 text-xs space-y-1">
                      <p className="font-medium">{m.tipoImpuesto ?? "Pago"} · {m.periodoMes ?? "?"}/{m.periodoAnio ?? "?"}</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                        <span>IVA a pagar:</span><span className="text-foreground">{money(m.ivaAPagar)}</span>
                        <span>ISR a pagar:</span><span className="text-foreground">{money(m.isrAPagar)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── STEP 3: Sincronización SAT ── */}
          {step === 3 && (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-md px-4 py-3 text-sm text-slate-700">
                ¿Qué tan atrás traemos tus CFDIs del SAT? Esto define la sincronización inicial; siempre se respeta tu fecha de inicio de operaciones.
              </div>
              <div className="space-y-2">
                {BACKFILL_OPTIONS.map((o) => (
                  <label
                    key={o.years}
                    className={`flex items-start gap-3 px-3 py-3 rounded-md cursor-pointer border ${
                      satBackfillYears === o.years ? "bg-blue-50 border-blue-400 ring-1 ring-blue-400" : "border-border hover:bg-accent"
                    }`}
                  >
                    <input
                      type="radio"
                      name="backfill"
                      checked={satBackfillYears === o.years}
                      onChange={() => setSatBackfillYears(o.years)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium">{o.label}</p>
                      <p className="text-xs text-muted-foreground">{o.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {/* ── STEP 4: Plan ── */}
          {step === 4 && (
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
                <Sparkles className="h-4 w-4 shrink-0" />
                Elige tu plan. Empiezas con una <strong>prueba gratis</strong> — no se cobra nada todavía.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {PLANS.map((p) => {
                  const selected = plan === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlan(p.id)}
                      className={`text-left rounded-lg border p-3 transition-colors relative ${
                        selected ? "border-blue-500 ring-2 ring-blue-400 bg-blue-50/50" : "border-border hover:bg-accent"
                      }`}
                    >
                      {p.highlight && (
                        <span className="absolute -top-2 right-2 text-[9px] font-semibold bg-blue-600 text-white px-1.5 py-0.5 rounded-full">
                          POPULAR
                        </span>
                      )}
                      <p className="text-sm font-bold">{p.name}</p>
                      <p className="text-lg font-bold">{p.price}<span className="text-xs font-normal text-muted-foreground"> MXN/mes</span></p>
                      <p className="text-[11px] text-muted-foreground mb-2">{p.blurb}</p>
                      <ul className="space-y-0.5">
                        {p.features.map((f, i) => (
                          <li key={i} className="flex items-start gap-1 text-[11px]">
                            <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0 mt-0.5" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground text-center">
                Sin tarjeta por ahora. Podrás cambiar de plan cuando activemos los pagos.
              </p>
            </>
          )}

          {/* ── STEP 5: Contacto ── */}
          {step === 5 && (
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

          {/* ── STEP 6: CSD ── */}
          {step === 6 && (
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

          {/* ── STEP 7: e.firma / FIEL ── */}
          {step === 7 && (
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

            {step === 0 ? null : step < LAST_STEP ? (
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

            {/* Skip CSD/FIEL steps (the optional credential steps) */}
            {(step === 6 || step === 7) && (
              <button
                type="button"
                onClick={() => step === LAST_STEP ? handleSubmit() : setStep((s) => s + 1)}
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
