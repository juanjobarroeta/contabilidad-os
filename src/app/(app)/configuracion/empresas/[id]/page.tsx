"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Building2, Loader2, CheckCircle2, AlertCircle,
  Upload, Eye, EyeOff, Shield, FileKey2, Save,
} from "lucide-react";
import { ClientInvitesPanel } from "./ClientInvitesPanel";
import { BitacoraPanel } from "./BitacoraPanel";
import { ZonaPeligroEmpresa } from "./ZonaPeligroEmpresa";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type CompanyDetail = {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
  domicilioFiscal: string | null;
  nombreComercial: string | null;
  email: string | null;
  telefono: string | null;
  actividadEconomica: string | null;
  registroPatronal: string | null;
  facturapiOrgId: string | null;
  facturapiConfigured?: boolean;
  csdCer: string | null;
  csdKey: string | null;
  fielCer: string | null;
  fielKey: string | null;
  fielVigencia: string | null;
  fielEstado?: "ok" | "por_vencer" | "vencida" | "sin_fiel";
};

const REGIMENES = [
  { value: "601", label: "601 – General de Ley Personas Morales" },
  { value: "603", label: "603 – Personas Morales con Fines no Lucrativos" },
  { value: "605", label: "605 – Sueldos y Salarios" },
  { value: "606", label: "606 – Arrendamiento" },
  { value: "607", label: "607 – Enajenación o Adquisición de Bienes" },
  { value: "608", label: "608 – Demás ingresos" },
  { value: "611", label: "611 – Ingresos por Dividendos" },
  { value: "612", label: "612 – Personas Físicas con Actividades Empresariales y Profesionales" },
  { value: "616", label: "616 – Sin obligaciones fiscales" },
  { value: "620", label: "620 – Sociedades Cooperativas de Producción" },
  { value: "621", label: "621 – Incorporación Fiscal" },
  { value: "622", label: "622 – Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras" },
  { value: "625", label: "625 – Plataformas Tecnológicas" },
  { value: "626", label: "626 – Régimen Simplificado de Confianza (RESICO)" },
];

export default function EmpresaEditPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState("");

  // Editable fiscal/contact fields
  const [razonSocial, setRazonSocial] = useState("");
  const [regimenFiscal, setRegimenFiscal] = useState("");
  const [codigoPostal, setCodigoPostal] = useState("");
  const [domicilioFiscal, setDomicilioFiscal] = useState("");
  const [nombreComercial, setNombreComercial] = useState("");
  const [email, setEmail] = useState("");
  const [telefono, setTelefono] = useState("");
  const [actividadEconomica, setActividadEconomica] = useState("");
  const [registroPatronal, setRegistroPatronal] = useState("");
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalSuccess, setGeneralSuccess] = useState("");

  // CSD
  const [csdCerFile, setCsdCerFile] = useState<File | null>(null);
  const [csdKeyFile, setCsdKeyFile] = useState<File | null>(null);
  const [csdPassword, setCsdPassword] = useState("");
  const [csdSaving, setCsdSaving] = useState(false);
  const [csdError, setCsdError] = useState("");
  const [csdSuccess, setCsdSuccess] = useState("");

  // FIEL
  const [fielCerFile, setFielCerFile] = useState<File | null>(null);
  const [fielKeyFile, setFielKeyFile] = useState<File | null>(null);
  const [fielPassword, setFielPassword] = useState("");
  const [showFielPw, setShowFielPw] = useState(false);
  const [fielSaving, setFielSaving] = useState(false);
  const [fielError, setFielError] = useState("");
  const [fielSuccess, setFielSuccess] = useState("");
  // Autorización de uso de la e.firma (/legal/mandato-efirma): se acepta en
  // cada carga/reemplazo; el servidor la exige también.
  const [mandatoEfirmaAck, setMandatoEfirmaAck] = useState(false);

  useEffect(() => {
    fetch(`/api/companies/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setCompany(data);
          setRazonSocial(data.razonSocial ?? "");
          setRegimenFiscal(data.regimenFiscal ?? "");
          setCodigoPostal(data.codigoPostal ?? "");
          setDomicilioFiscal(data.domicilioFiscal ?? "");
          setNombreComercial(data.nombreComercial ?? "");
          setEmail(data.email ?? "");
          setTelefono(data.telefono ?? "");
          setActividadEconomica(data.actividadEconomica ?? "");
          setRegistroPatronal(data.registroPatronal ?? "");
        }
      })
      .catch(() => setError("Error al cargar la empresa"))
      .finally(() => setLoading(false));
  }, [id]);

  const hasCsd = !!(company?.csdCer);
  const hasFiel = !!(company?.fielCer);
  // Vigencia de la e.firma: "Configurada" ya no basta — un certificado vencido
  // detiene la sincronización con el SAT aunque los archivos estén cargados.
  const fielEstado = hasFiel ? (company?.fielEstado ?? "ok") : "sin_fiel";
  const fielVigenciaFmt = company?.fielVigencia
    ? new Date(company.fielVigencia).toLocaleDateString("es-MX", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Mexico_City",
      })
    : null;
  const fielBadge =
    fielEstado === "vencida"
      ? { clase: "bg-cos-red-tint text-cos-red-ink", texto: fielVigenciaFmt ? `Vencida el ${fielVigenciaFmt} — renueva tu e.firma en el SAT` : "Vencida — renueva tu e.firma en el SAT" }
      : fielEstado === "por_vencer"
        ? { clase: "bg-cos-amber-tint text-cos-amber-ink", texto: fielVigenciaFmt ? `Vence el ${fielVigenciaFmt}` : "Por vencer" }
        : fielEstado === "ok"
          ? { clase: "bg-cos-jade-tint text-cos-jade-ink", texto: fielVigenciaFmt ? `Vigente hasta ${fielVigenciaFmt}` : "✓ Configurada" }
          : { clase: "bg-cos-amber-tint text-cos-amber-ink", texto: "Sin configurar" };

  async function handleSaveGeneral() {
    setGeneralSaving(true);
    setError("");
    setGeneralSuccess("");
    try {
      const res = await fetch(`/api/companies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razonSocial, regimenFiscal, codigoPostal, domicilioFiscal,
          nombreComercial, email, telefono, actividadEconomica, registroPatronal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar");
      setGeneralSuccess("Datos guardados correctamente");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setGeneralSaving(false);
    }
  }

  async function handleCsdUpload() {
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
      const res = await fetch(`/api/companies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csdCer, csdKey, csdPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar el CSD");
      const fp = data.facturapi;
      if (fp?.liveKeyGenerated) {
        setCsdSuccess("CSD guardado y clave live de Facturapi generada. Ya puedes timbrar CFDIs.");
      } else if (fp?.csdUploaded) {
        setCsdSuccess("CSD guardado y subido a Facturapi.");
      } else {
        setCsdSuccess("CSD guardado correctamente.");
      }
      setCompany((c) => c ? { ...c, csdCer: "[stored]", csdKey: "[stored]" } : c);
    } catch (e) {
      setCsdError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setCsdSaving(false);
    }
  }

  async function handleFielUpload() {
    if (!fielCerFile || !fielKeyFile || !fielPassword) {
      setFielError("Sube el .cer, el .key y la contraseña de la e.firma");
      return;
    }
    if (!mandatoEfirmaAck) {
      setFielError("Acepta la Autorización de uso de la e.firma para guardarla.");
      return;
    }
    setFielSaving(true);
    setFielError("");
    setFielSuccess("");
    try {
      const fielCer = await fileToBase64(fielCerFile);
      const fielKey = await fileToBase64(fielKeyFile);
      const res = await fetch(`/api/companies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fielCer, fielKey, fielPassword, aceptaMandatoEfirma: mandatoEfirmaAck }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar la e.firma");
      setFielSuccess("e.firma guardada correctamente.");
      setMandatoEfirmaAck(false);
      setCompany((c) => c ? { ...c, fielCer: "[stored]", fielKey: "[stored]" } : c);
    } catch (e) {
      setFielError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setFielSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-cos-ink-soft text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando empresa…
      </div>
    );
  }
  if (!company) {
    return (
      <div className="p-6">
        <p className="text-cos-red-ink text-sm">{error || "Empresa no encontrada"}</p>
        <Link href="/empresa" className="text-cos-brand-ink text-sm hover:underline mt-2 inline-block">
          ← Volver
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/empresa"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Volver a Empresa
      </Link>

      <div className="flex items-start gap-4 mb-6">
        <div className="h-12 w-12 rounded-lg bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
          <Building2 className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold">{company.razonSocial}</h1>
          <p className="text-sm text-cos-ink-soft font-mono">{company.rfc}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-4 py-3 text-sm text-cos-red-ink mb-4">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Datos Generales ── */}
      <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
        <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-cos-brand-ink" />
          Datos Generales
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium mb-1">Razón Social</label>
            <input
              type="text" value={razonSocial} onChange={(e) => setRazonSocial(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Régimen Fiscal</label>
            <select
              value={regimenFiscal} onChange={(e) => setRegimenFiscal(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            >
              <option value="">Selecciona…</option>
              {REGIMENES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Código Postal</label>
            <input
              type="text" value={codigoPostal} onChange={(e) => setCodigoPostal(e.target.value)}
              maxLength={5} className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium mb-1">Domicilio Fiscal</label>
            <input
              type="text" value={domicilioFiscal} onChange={(e) => setDomicilioFiscal(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Nombre Comercial</label>
            <input
              type="text" value={nombreComercial} onChange={(e) => setNombreComercial(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Correo</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Teléfono</label>
            <input
              type="text" value={telefono} onChange={(e) => setTelefono(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Actividad Económica</label>
            <input
              type="text" value={actividadEconomica} onChange={(e) => setActividadEconomica(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Registro Patronal IMSS</label>
            <input
              type="text" value={registroPatronal} onChange={(e) => setRegistroPatronal(e.target.value.toUpperCase())}
              placeholder="E.g. E0818935102"
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
          </div>
        </div>

        {generalSuccess && (
          <div className="flex items-center gap-2 mt-3 text-xs text-cos-jade-ink">
            <CheckCircle2 className="h-3.5 w-3.5" /> {generalSuccess}
          </div>
        )}

        <button
          onClick={handleSaveGeneral}
          disabled={generalSaving}
          className="mt-4 flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {generalSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Guardar cambios
        </button>
      </section>

      {/* ── CSD ── */}
      <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <FileKey2 className="h-4 w-4 text-cos-brand-ink" />
            Certificado de Sello Digital (CSD)
          </h2>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${hasCsd ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-amber-tint text-cos-amber-ink"}`}>
            {hasCsd ? "✓ Guardado" : "Sin configurar"}
          </span>
        </div>
        <p className="text-xs text-cos-ink-soft mb-3">
          El CSD es necesario para timbrar CFDIs a través de Facturapi. Al subirlo se provisiona automáticamente la organización en Facturapi.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Certificado <code>.cer</code></label>
            <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
              <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
              <span className="text-cos-ink-soft truncate">{csdCerFile ? csdCerFile.name : "Seleccionar .cer"}</span>
              <input type="file" accept=".cer,application/x-x509-ca-cert,application/pkix-cert,application/octet-stream" className="hidden"
                onChange={(e) => setCsdCerFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Llave privada <code>.key</code></label>
            <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
              <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
              <span className="text-cos-ink-soft truncate">{csdKeyFile ? csdKeyFile.name : "Seleccionar .key"}</span>
              <input type="file" accept=".key,application/pkcs8,application/octet-stream" className="hidden"
                onChange={(e) => setCsdKeyFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Contraseña del CSD</label>
            <input
              type="password" value={csdPassword} onChange={(e) => setCsdPassword(e.target.value)}
              placeholder="Contraseña de la llave privada"
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm"
            />
          </div>
          {csdError && <p className="text-xs text-cos-red-ink">{csdError}</p>}
          {csdSuccess && <p className="text-xs text-cos-jade-ink">{csdSuccess}</p>}
          <button
            onClick={handleCsdUpload}
            disabled={csdSaving || !csdCerFile || !csdKeyFile || !csdPassword}
            className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
          >
            {csdSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileKey2 className="h-4 w-4" />}
            {csdSaving ? "Subiendo…" : hasCsd ? "Actualizar CSD" : "Subir CSD"}
          </button>
        </div>
      </section>

      {/* ── FIEL ── */}
      <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-cos-amber-ink" />
            e.firma / FIEL
          </h2>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${fielBadge.clase}`}>
            {fielBadge.texto}
          </span>
        </div>
        <p className="text-xs text-cos-ink-soft mb-3">
          La Firma Electrónica Avanzada te permite autenticarte ante el SAT para descargar CFDIs emitidos y recibidos.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Certificado <code>.cer</code></label>
            <label className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
              <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
              <span className="text-cos-ink-soft truncate">{fielCerFile ? fielCerFile.name : "Seleccionar .cer"}</span>
              <input type="file" accept=".cer,application/x-x509-ca-cert,application/pkix-cert,application/octet-stream" className="hidden"
                onChange={(e) => setFielCerFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Llave privada <code>.key</code></label>
            <label className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-cos-line rounded-md text-xs cursor-pointer hover:bg-cos-paper">
              <Upload className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
              <span className="text-cos-ink-soft truncate">{fielKeyFile ? fielKeyFile.name : "Seleccionar .key"}</span>
              <input type="file" accept=".key,application/pkcs8,application/octet-stream" className="hidden"
                onChange={(e) => setFielKeyFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium mb-1">Contraseña de la e.firma</label>
          <div className="relative">
            <input
              type={showFielPw ? "text" : "password"}
              value={fielPassword} onChange={(e) => setFielPassword(e.target.value)}
              placeholder="Contraseña de la llave privada"
              className="w-full px-3 py-2 pr-10 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
            />
            <button type="button" onClick={() => setShowFielPw((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-cos-ink-soft hover:text-cos-ink">
              {showFielPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <label className="mt-3 flex items-start gap-2 rounded-md border border-cos-line px-3 py-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={mandatoEfirmaAck}
            onChange={(e) => setMandatoEfirmaAck(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs leading-relaxed text-cos-ink-soft">
            Declaro que estoy facultado para usar la e.firma de esta empresa y acepto la{" "}
            <a href="/legal/mandato-efirma" target="_blank" rel="noopener noreferrer" className="font-medium text-cos-brand-ink hover:underline">
              Autorización de uso de la e.firma
            </a>
            : ContabilidadOS la usará únicamente para autenticarse ante el SAT y descargar la información fiscal de esta empresa.
          </span>
        </label>
        {fielError && <p className="text-xs text-cos-red-ink mt-2">{fielError}</p>}
        {fielSuccess && <p className="text-xs text-cos-jade-ink mt-2">{fielSuccess}</p>}
        <button
          onClick={handleFielUpload}
          disabled={fielSaving || !fielCerFile || !fielKeyFile || !fielPassword || !mandatoEfirmaAck}
          className="mt-3 flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {fielSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
          {hasFiel ? "Actualizar e.firma" : "Guardar e.firma"}
        </button>
      </section>

      {/* Invitar cliente a esta empresa (solo admins del despacho dueño) */}
      <ClientInvitesPanel companyId={id} />

      {/* Bitácora de seguridad — registro inmutable (solo OWNER/ADMIN) */}
      <BitacoraPanel companyId={id} />

      {/* Zona de peligro — baja definitiva (solo OWNER directo) */}
      <ZonaPeligroEmpresa companyId={id} rfc={company.rfc} />
    </div>
  );
}
