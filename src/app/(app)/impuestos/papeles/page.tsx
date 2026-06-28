"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { ArrowLeft, Printer, FileText, Calculator, BookOpen } from "lucide-react";
import { IvaPanel, IsrPanel, RetencionesPanel } from "@/components/papeles/panels";

type TabId = "iva" | "isr" | "retenciones";

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default function PapelesPage() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [tab, setTab] = useState<TabId>("iva");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  // Honor deep-links from the cierre workspace (?tab=&month=&year=). Read from
  // the URL directly to avoid forcing a Suspense boundary (useSearchParams).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("tab");
    if (t === "iva" || t === "isr" || t === "retenciones") setTab(t);
    const m = parseInt(sp.get("month") ?? "");
    if (m >= 1 && m <= 12) setMonth(m);
    const y = parseInt(sp.get("year") ?? "");
    if (y >= 2000 && y <= 2100) setYear(y);
  }, []);

  if (!activeCompany) {
    return (
      <div className="p-8 text-cos-ink-soft text-sm">
        Selecciona una empresa para ver sus papeles de trabajo.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl print:p-0 print:max-w-none">
      {/* Print-hidden header */}
      <div className="print:hidden">
        <Link
          href="/impuestos"
          className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Declaraciones Fiscales
        </Link>

        <div className="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-bold">Papeles de trabajo</h1>
            <p className="text-sm text-cos-ink-soft mt-0.5">
              {activeCompany.razonSocial} — auditable, descargable, imprimible
            </p>
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper"
          >
            <Printer className="h-4 w-4" /> Imprimir
          </button>
        </div>

        {/* Period + tab selector */}
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value))}
            className="text-sm border border-cos-line rounded-md px-3 py-2 bg-white"
          >
            {MONTHS.map((m, i) => (
              <option key={i} value={i + 1}>{m}</option>
            ))}
          </select>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value))}
            className="w-24 text-sm border border-cos-line rounded-md px-3 py-2 bg-white"
          />
        </div>

        <div className="border-b border-cos-line mb-5">
          <div className="flex gap-1">
            {([
              ["iva", "IVA", Calculator],
              ["isr", "ISR Provisional", FileText],
              ["retenciones", "Retenciones", BookOpen],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === id
                    ? "border-cos-brand text-cos-brand-ink"
                    : "border-transparent text-cos-ink-soft hover:text-cos-ink"
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === "iva" && <IvaPanel companyId={activeCompany.id} year={year} month={month} />}
      {tab === "isr" && <IsrPanel companyId={activeCompany.id} year={year} month={month} />}
      {tab === "retenciones" && <RetencionesPanel companyId={activeCompany.id} year={year} month={month} />}
    </div>
  );
}
