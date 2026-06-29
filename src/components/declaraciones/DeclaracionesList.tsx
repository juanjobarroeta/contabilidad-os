"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { FileText, CheckCircle2, Loader2, Download } from "lucide-react";
import { FaltantesUploader, type EmpresaCobertura } from "@/components/declaraciones/FaltantesUploader";

type Cobertura = { total: number; empresasConFaltantes: number; empresas: EmpresaCobertura[] };
type Acuse = { id: string; tipo: string; periodo: string; fechaPresentacion: string | null; razonSocial: string; rfc: string };

const TIPO_LABEL: Record<string, string> = {
  DECLARACION_ANUAL: "Anual",
  IVA_MENSUAL: "IVA",
  ISR_PROVISIONAL: "ISR prov.",
};

export function DeclaracionesList() {
  const [data, setData] = useState<Cobertura | null>(null);
  const [acuses, setAcuses] = useState<Acuse[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cob, acu] = await Promise.all([
        fetch("/api/declaraciones/cobertura").then((r) => r.json()),
        fetch("/api/declaraciones/acuses").then((r) => (r.ok ? r.json() : { acuses: [] })),
      ]);
      setData(cob);
      setAcuses(acu.acuses ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-5 w-5 text-cos-brand" />
        <h1 className="text-xl font-bold text-cos-ink">Declaraciones por capturar</h1>
        <Link
          href="/declaraciones/historial"
          className="ml-auto rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] font-medium text-cos-ink hover:bg-cos-paper"
        >
          Ver presentadas
        </Link>
      </div>
      <p className="mt-1 text-sm text-cos-ink-soft">
        Sube el <strong>acuse en PDF</strong> de cada declaración — el que emite el SAT al
        <strong> presentarla</strong>, <em>no</em> el recibo de pago ni la línea de captura. Lo leemos
        y guardamos el documento completo para calcular saldos a favor, coeficiente de utilidad y
        pagos provisionales. No necesitas teclear montos.
      </p>

      {loading ? (
        <div className="mt-10 flex items-center gap-2 text-cos-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> Revisando qué falta…
        </div>
      ) : !data || data.total === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-card border border-cos-line bg-cos-card py-12 text-center">
          <CheckCircle2 className="h-8 w-8 text-cos-green-ink" />
          <p className="font-medium text-cos-ink">Todo al día</p>
          <p className="text-sm text-cos-ink-faint">No hay acuses pendientes por capturar.</p>
        </div>
      ) : (
        <div className="mt-6">
          <FaltantesUploader empresas={data.empresas} onUploaded={load} />
          <div className="mt-5 flex justify-end">
            <button onClick={load} className="text-[13px] text-cos-brand-ink hover:underline">
              Actualizar lista
            </button>
          </div>
        </div>
      )}

      {acuses.length > 0 && (
        <div className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <Download className="h-4 w-4 text-cos-ink-faint" />
            <h2 className="text-sm font-semibold text-cos-ink">Acuses disponibles</h2>
            <span className="text-[12px] text-cos-ink-faint">PDF guardado · {acuses.length}</span>
          </div>
          <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <ul className="divide-y divide-cos-line">
              {acuses.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-cos-ink">
                      <span className="font-medium">{TIPO_LABEL[a.tipo] ?? a.tipo}</span> · {a.periodo}
                    </p>
                    <p className="truncate text-[12px] text-cos-ink-faint">{a.razonSocial}</p>
                  </div>
                  <Link
                    href={`/declaraciones/acuse/${a.id}`}
                    className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[13px] font-medium text-cos-ink hover:bg-cos-paper"
                  >
                    <Download className="h-3.5 w-3.5" /> PDF
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
