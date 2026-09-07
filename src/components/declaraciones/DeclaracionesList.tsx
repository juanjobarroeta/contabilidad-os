"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL EXPEDIENTE DE LA EMPRESA: lo presentado al SAT y lo que falta, junto.
//
// Antes esta pantalla mezclaba TODAS las empresas del despacho, abría con la
// lista de lo que falta —el trabajo pendiente de veintitantos RFCs— y lo que sí
// se presentó vivía detrás de un botón «Ver presentadas». Quien viene a ver el
// expediente de un RFC quiere ese RFC, y quiere ver primero lo que hay.
//
// Ahora: la empresa activa, lo presentado arriba agrupado por ejercicio y con
// su descarga, y debajo lo que falta con su subida de acuses.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, Download, FileText, Loader2, Upload } from "lucide-react";
import { Alert, RetryButton } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { FaltantesUploader, type EmpresaCobertura } from "@/components/declaraciones/FaltantesUploader";
import { haceCuanto } from "@/lib/tiempo-relativo";
import { cn } from "@/lib/utils";
import type { FilaExpediente } from "@/lib/fiscal/expediente";

type AcuseFaltante = EmpresaCobertura["faltantes"][number];

type Expediente = {
  empresa: { companyId: string; rfc: string; razonSocial: string };
  presentadas: FilaExpediente[];
  faltantes: AcuseFaltante[];
};

export function DeclaracionesList() {
  const { activeCompany } = useCompany();
  const [data, setData] = useState<Expediente | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [aniosCerrados, setAniosCerrados] = useState<Set<number>>(new Set());
  const [verFaltantes, setVerFaltantes] = useState(false);

  const companyId = activeCompany?.id;

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/declaraciones/expediente?companyId=${companyId}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setData(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const q = busqueda.trim().toLowerCase();
  const porAnio = useMemo(() => {
    const filas = (data?.presentadas ?? []).filter(
      (f) => !q || f.etiquetaTipo.toLowerCase().includes(q) || f.periodoLegible.includes(q) || f.periodo.includes(q)
    );
    const m = new Map<number, FilaExpediente[]>();
    for (const f of filas) m.set(f.anio, [...(m.get(f.anio) ?? []), f]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [data, q]);

  const faltantes = data?.faltantes ?? [];
  const empresaCobertura: EmpresaCobertura[] = data
    ? [{ companyId: data.empresa.companyId, rfc: data.empresa.rfc, razonSocial: data.empresa.razonSocial, faltantes }]
    : [];

  if (!activeCompany) {
    return <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-5 w-5 text-cos-brand" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-cos-ink">Lo presentado al SAT</h1>
          <p className="truncate text-[12.5px] text-cos-ink-soft">
            {activeCompany.razonSocial} · {activeCompany.rfc}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-10 flex items-center gap-2 text-cos-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> Armando el expediente…
        </div>
      ) : error || !data ? (
        <Alert tone="danger" className="mt-10" action={<RetryButton onClick={load} />}>
          No se pudo cargar el expediente de esta empresa.
        </Alert>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-cos-ink">
              <strong>{data.presentadas.length}</strong> {data.presentadas.length === 1 ? "documento" : "documentos"} en el
              expediente
            </span>
            {faltantes.length > 0 && (
              <button
                type="button"
                onClick={() => setVerFaltantes((v) => !v)}
                className="rounded-control border border-cos-amber-ink/30 bg-cos-amber-tint px-2.5 py-1 text-[12.5px] font-medium text-cos-amber-ink"
              >
                {faltantes.length} por capturar
              </button>
            )}
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="IVA, anual, DIOT, 2025, agosto…"
              className="ml-auto min-w-[200px] flex-1 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-cos-brand-tint"
            />
          </div>

          {/* Lo presentado, por ejercicio. */}
          {porAnio.length === 0 ? (
            <p className="mt-6 rounded-card border border-cos-line bg-cos-card px-4 py-8 text-center text-sm text-cos-ink-faint">
              {q
                ? "Nada del expediente coincide con esa búsqueda."
                : "Todavía no hay nada presentado registrado para esta empresa."}
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {porAnio.map(([anio, filas]) => {
                const cerrado = aniosCerrados.has(anio);
                return (
                  <section key={anio} className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
                    <button
                      type="button"
                      onClick={() =>
                        setAniosCerrados((prev) => {
                          const s = new Set(prev);
                          if (s.has(anio)) s.delete(anio);
                          else s.add(anio);
                          return s;
                        })
                      }
                      className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-cos-paper"
                      aria-expanded={!cerrado}
                    >
                      <span className="text-[13.5px] font-semibold text-cos-ink">{anio}</span>
                      <span className="flex items-center gap-2 text-[12px] text-cos-ink-soft">
                        {filas.length} {filas.length === 1 ? "documento" : "documentos"}
                        <ChevronDown className={cn("h-4 w-4 transition-transform", cerrado && "-rotate-90")} />
                      </span>
                    </button>
                    {!cerrado && (
                      <ul className="divide-y divide-cos-line border-t border-cos-line">
                        {filas.map((f) => (
                          <li key={f.clave} className="flex items-center gap-3 px-4 py-2.5">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cos-jade-ink" />
                            <div className="min-w-0 flex-1">
                              <p className="text-[13.5px] text-cos-ink">
                                <span className="font-medium">{f.etiquetaTipo}</span> · {f.periodoLegible}
                              </p>
                              <p className="truncate text-[12px] text-cos-ink-faint">
                                {f.origen}
                                {f.fecha ? ` · ${haceCuanto(f.fecha)}` : ""}
                                {f.lineaCaptura ? ` · línea ${f.lineaCaptura}` : ""}
                              </p>
                            </div>
                            {f.descarga && (
                              <Link
                                href={f.descarga}
                                className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] font-medium text-cos-ink hover:bg-cos-paper"
                              >
                                <Download className="h-3.5 w-3.5" /> Abrir
                              </Link>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}

          {/* Lo que falta, en la misma página. */}
          <section className="mt-6">
            {faltantes.length === 0 ? (
              <p className="flex items-center gap-2 rounded-card border border-cos-jade-ink/25 bg-cos-jade-tint px-4 py-3 text-[13px] text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> No falta ningún acuse por capturar.
              </p>
            ) : (
              <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
                <button
                  type="button"
                  onClick={() => setVerFaltantes((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                  aria-expanded={verFaltantes}
                >
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
                    <Upload className="h-4 w-4 text-cos-amber-ink" /> Faltan {faltantes.length} por capturar
                  </span>
                  <ChevronDown className={cn("h-4 w-4 text-cos-ink-faint transition-transform", verFaltantes && "rotate-180")} />
                </button>
                {verFaltantes && (
                  <div className="border-t border-cos-line p-4">
                    <p className="mb-3 text-[12.5px] text-cos-ink-soft">
                      Sube el <strong>acuse en PDF</strong> — el que emite el SAT al <strong>presentarla</strong>, no el
                      recibo de pago ni la línea de captura. Lo leemos y guardamos completo para calcular saldos a favor,
                      coeficiente de utilidad y pagos provisionales. No hay que teclear montos.
                    </p>
                    <FaltantesUploader empresas={empresaCobertura} onUploaded={load} />
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
