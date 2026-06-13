"use client";

import { useEffect, useState, useCallback } from "react";
import { FileText, CheckCircle2, Loader2, UploadCloud, AlertCircle, Building2 } from "lucide-react";

type Faltante = {
  companyId: string;
  tipo: "DECLARACION_ANUAL" | "IVA_MENSUAL" | "ISR_PROVISIONAL";
  periodo: string;
  etiqueta: string;
  motivo: string;
};
type EmpresaCobertura = {
  companyId: string;
  rfc: string;
  razonSocial: string;
  faltantes: Faltante[];
};
type Cobertura = { total: number; empresasConFaltantes: number; empresas: EmpresaCobertura[] };

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(f);
  });

export default function DeclaracionesPage() {
  const [data, setData] = useState<Cobertura | null>(null);
  const [loading, setLoading] = useState(true);
  // estado por fila: "idle" | "subiendo" | "ok" | "error:<msg>"
  const [estado, setEstado] = useState<Record<string, string>>({});

  const key = (f: Faltante) => `${f.companyId}:${f.tipo}:${f.periodo}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/declaraciones/cobertura");
      setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function subir(f: Faltante, file: File) {
    const k = key(f);
    setEstado((s) => ({ ...s, [k]: "subiendo" }));
    try {
      // 1. Parseo con el extractor existente (Claude Vision).
      const form = new FormData();
      form.append("file", file);
      const pres = await fetch("/api/onboarding/parse-document", { method: "POST", body: form });
      const parsed = await pres.json();
      if (!pres.ok) throw new Error(parsed.error || "No se pudo leer el PDF");

      const acuse =
        f.tipo === "DECLARACION_ANUAL" ? parsed.extracted?.acuseAnual : parsed.extracted?.acuseMensual;

      // 2. Guardar campos + PDF completo.
      const pdfBase64 = await fileToBase64(file);
      const sres = await fetch("/api/declaraciones/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: f.companyId,
          tipo: f.tipo,
          periodo: f.periodo,
          pdfBase64,
          filename: file.name,
          acuse: acuse ?? {},
        }),
      });
      const saved = await sres.json();
      if (!sres.ok) throw new Error(saved.error || "No se pudo guardar");
      setEstado((s) => ({ ...s, [k]: "ok" }));
    } catch (e) {
      setEstado((s) => ({ ...s, [k]: `error:${e instanceof Error ? e.message : "Error"}` }));
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-cos-brand" />
        <h1 className="text-xl font-bold text-cos-ink">Declaraciones por capturar</h1>
      </div>
      <p className="mt-1 text-sm text-cos-ink-soft">
        Sube el <strong>acuse en PDF</strong> de cada declaración. Lo leemos y guardamos el
        documento completo para calcular saldos a favor, coeficiente de utilidad y pagos
        provisionales. No necesitas teclear línea de captura ni montos.
      </p>

      {loading ? (
        <div className="mt-10 flex items-center gap-2 text-cos-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> Revisando qué falta…
        </div>
      ) : !data || data.total === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-card border border-cos-line bg-white py-12 text-center">
          <CheckCircle2 className="h-8 w-8 text-cos-green-ink" />
          <p className="font-medium text-cos-ink">Todo al día</p>
          <p className="text-sm text-cos-ink-faint">No hay acuses pendientes por capturar.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {data.empresas.map((emp) => (
            <div key={emp.companyId} className="overflow-hidden rounded-card border border-cos-line bg-white shadow-card">
              <div className="flex items-center gap-2 border-b border-cos-line bg-cos-paper px-4 py-2.5">
                <Building2 className="h-4 w-4 text-cos-ink-faint" />
                <span className="text-sm font-semibold text-cos-ink">{emp.razonSocial}</span>
                <span className="font-mono text-[11px] text-cos-ink-faint">{emp.rfc}</span>
                <span className="ml-auto text-[12px] text-cos-ink-faint">{emp.faltantes.length} pendientes</span>
              </div>
              <ul className="divide-y divide-cos-line">
                {emp.faltantes.map((f) => {
                  const k = key(f);
                  const st = estado[k] ?? "idle";
                  const done = st === "ok";
                  const err = st.startsWith("error:");
                  return (
                    <li key={k} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-cos-ink">{f.etiqueta}</p>
                        <p className="text-[12px] text-cos-ink-faint">{f.motivo}</p>
                        {err && (
                          <p className="mt-0.5 flex items-center gap-1 text-[12px] text-cos-red-ink">
                            <AlertCircle className="h-3.5 w-3.5" /> {st.slice(6)}
                          </p>
                        )}
                      </div>
                      {done ? (
                        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-cos-green-ink">
                          <CheckCircle2 className="h-4 w-4" /> Guardado
                        </span>
                      ) : st === "subiendo" ? (
                        <span className="inline-flex items-center gap-1 text-[13px] text-cos-ink-faint">
                          <Loader2 className="h-4 w-4 animate-spin" /> Leyendo…
                        </span>
                      ) : (
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep">
                          <UploadCloud className="h-3.5 w-3.5" /> Subir PDF
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) subir(f, file);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <div className="flex justify-end">
            <button onClick={load} className="text-[13px] text-cos-brand-ink hover:underline">
              Actualizar lista
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
