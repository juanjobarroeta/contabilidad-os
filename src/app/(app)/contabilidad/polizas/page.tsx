"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, FileDown } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card } from "@/components/ui";

type Tipo = "AF" | "FC" | "DE" | "CO";

const TIPOS: { value: Tipo; label: string }[] = [
  { value: "AF", label: "AF — Acto de fiscalización" },
  { value: "FC", label: "FC — Fiscalización compulsa" },
  { value: "DE", label: "DE — Devolución" },
  { value: "CO", label: "CO — Compensación" },
];

// AF/FC usan NumOrden; DE/CO usan NumTramite.
const usaOrden = (t: Tipo) => t === "AF" || t === "FC";
// Patrones del SAT (Anexo 24).
const ORDEN_RE = /^[A-Z]{3}[0-9]{7}\/[0-9]{2}$/; // p.ej. ABC1234567/26
const TRAMITE_RE = /^[A-Z]{2}[0-9]{12}$/; // p.ej. AB123456789012

export default function PolizasPage() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [tipo, setTipo] = useState<Tipo>("DE");
  const [folio, setFolio] = useState("");

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  const folioValido = usaOrden(tipo) ? ORDEN_RE.test(folio) : TRAMITE_RE.test(folio);
  const params = new URLSearchParams({
    companyId: activeCompany.id,
    year: String(year),
    month: String(month),
    tipoSolicitud: tipo,
    ...(usaOrden(tipo) ? { numOrden: folio } : { numTramite: folio }),
  });
  const href = `/api/contabilidad/coe/polizas?${params.toString()}`;

  return (
    <div className="mx-auto max-w-[680px] px-4 py-6 sm:px-8 sm:py-8">
      <Link href="/contabilidad" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-soft hover:text-cos-ink">
        <ChevronLeft className="h-4 w-4" /> Contabilidad
      </Link>
      <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.03em] text-cos-ink">Pólizas del periodo</h1>
      <p className="mt-1 max-w-[60ch] text-[15px] text-cos-ink-soft">
        XML de pólizas que el SAT solicita en una auditoría, devolución o compensación. Indica el tipo de
        solicitud y su folio (orden o trámite).
      </p>

      <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
        <div className="grid grid-cols-2 gap-4">
          <label className="text-[13px]">
            <span className="mb-1 block font-medium text-cos-ink-soft">Año</span>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="w-full rounded-control border border-cos-line px-2.5 py-1.5 outline-none focus:border-cos-brand-ink" />
          </label>
          <label className="text-[13px]">
            <span className="mb-1 block font-medium text-cos-ink-soft">Mes</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
              className="w-full rounded-control border border-cos-line bg-white px-2.5 py-1.5 outline-none focus:border-cos-brand-ink">
              {Array.from({ length: 13 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m === 13 ? "13 (cierre)" : m}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-4 block text-[13px]">
          <span className="mb-1 block font-medium text-cos-ink-soft">Tipo de solicitud</span>
          <select value={tipo} onChange={(e) => { setTipo(e.target.value as Tipo); setFolio(""); }}
            className="w-full rounded-control border border-cos-line bg-white px-2.5 py-1.5 outline-none focus:border-cos-brand-ink">
            {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <label className="mt-4 block text-[13px]">
          <span className="mb-1 block font-medium text-cos-ink-soft">
            {usaOrden(tipo) ? "Número de orden" : "Número de trámite"}
          </span>
          <input
            value={folio}
            onChange={(e) => setFolio(e.target.value.toUpperCase())}
            placeholder={usaOrden(tipo) ? "ABC1234567/26" : "AB123456789012"}
            className="w-full rounded-control border border-cos-line px-2.5 py-1.5 font-mono outline-none focus:border-cos-brand-ink"
          />
          <span className="mt-1 block text-[12px] text-cos-ink-faint">
            {usaOrden(tipo) ? "Formato: 3 letras + 7 dígitos + “/” + 2 dígitos." : "Formato: 2 letras + 12 dígitos."}
          </span>
        </label>

        <a
          href={folioValido ? href : undefined}
          aria-disabled={!folioValido}
          className={`mt-5 inline-flex items-center gap-1.5 rounded-control px-4 py-2 text-[14px] font-semibold ${
            folioValido
              ? "bg-cos-jade text-white hover:opacity-90"
              : "pointer-events-none bg-cos-slate-tint text-cos-ink-faint"
          }`}
        >
          <FileDown className="h-4 w-4" /> Descargar pólizas XML
        </a>
      </Card>
    </div>
  );
}
