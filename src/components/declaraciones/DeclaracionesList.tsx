"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { FileText, CheckCircle2, Loader2, Download } from "lucide-react";
import { Alert, RetryButton } from "@/components/ui";
import { FaltantesUploader, type EmpresaCobertura } from "@/components/declaraciones/FaltantesUploader";

type Cobertura = { total: number; empresasConFaltantes: number; empresas: EmpresaCobertura[] };
type Acuse = { id: string; tipo: string; periodo: string; fechaPresentacion: string | null; razonSocial: string; rfc: string };

const TIPO_LABEL: Record<string, string> = {
  DECLARACION_ANUAL: "Anual",
  IVA_MENSUAL: "IVA",
  ISR_PROVISIONAL: "ISR prov.",
  IEPS_MENSUAL: "IEPS",
};

export function DeclaracionesList() {
  const [data, setData] = useState<Cobertura | null>(null);
  const [acuses, setAcuses] = useState<Acuse[]>([]);
  const [loading, setLoading] = useState(true);
  // Filtros de la lista de acuses (519+ renglones sin filtro era inservible;
  // además el orden por periodo desc entierra las anuales — "2026-05" > "2025").
  const [filtroTipo, setFiltroTipo] = useState<string>("TODAS");
  const [busqueda, setBusqueda] = useState("");

  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // La cobertura es el dato primario: sin .ok/.catch, una falla de red se
      // veía como "Todo al día" — un falso vacío en la pantalla de captura.
      const [cobRes, acuRes] = await Promise.all([
        fetch("/api/declaraciones/cobertura"),
        fetch("/api/declaraciones/acuses").catch(() => null),
      ]);
      if (!cobRes.ok) throw new Error();
      const cob: Cobertura = await cobRes.json();
      // Los acuses son secundarios: si fallan, la lista simplemente no se muestra.
      const acu = acuRes?.ok ? await acuRes.json() : { acuses: [] };
      setData(cob);
      setAcuses(acu.acuses ?? []);
    } catch {
      setData(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const q = busqueda.trim().toLowerCase();
  const acusesFiltrados = acuses.filter((a) => {
    if (filtroTipo !== "TODAS" && a.tipo !== filtroTipo) return false;
    if (!q) return true;
    return (
      a.razonSocial.toLowerCase().includes(q) ||
      a.rfc.toLowerCase().includes(q) ||
      a.periodo.toLowerCase().includes(q)
    );
  });

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
      ) : error ? (
        <Alert tone="danger" className="mt-10" action={<RetryButton onClick={load} />}>
          No se pudo cargar la lista de declaraciones por capturar.
        </Alert>
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
            <span className="text-[12px] text-cos-ink-faint">
              PDF guardado · {acusesFiltrados.length}
              {acusesFiltrados.length !== acuses.length ? ` de ${acuses.length}` : ""}
            </span>
          </div>

          {/* Filtros: por tipo (las anuales existen pero el orden cronológico
              las entierra bajo cientos de mensuales) y búsqueda libre. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-cos-line bg-cos-card p-1" role="group" aria-label="Filtrar por tipo">
              {(["TODAS", "DECLARACION_ANUAL", "IVA_MENSUAL", "ISR_PROVISIONAL", "IEPS_MENSUAL"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFiltroTipo(t)}
                  aria-pressed={filtroTipo === t}
                  className={`rounded-md px-2.5 py-1 text-[12.5px] font-semibold transition-all ${
                    filtroTipo === t ? "bg-cos-brand-tint text-cos-brand-ink" : "text-cos-ink-soft hover:text-cos-ink"
                  }`}
                >
                  {t === "TODAS" ? "Todas" : TIPO_LABEL[t]}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Empresa, RFC o periodo (2025, 2026-05…)"
              className="min-w-[220px] flex-1 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-cos-brand-tint"
            />
          </div>

          {acusesFiltrados.length === 0 ? (
            <p className="rounded-card border border-cos-line bg-cos-card px-4 py-6 text-center text-sm text-cos-ink-faint">
              Ningún acuse coincide con el filtro.
              {filtroTipo === "DECLARACION_ANUAL" &&
                " Si esperabas una anual aquí, es que su PDF no está guardado: súbela arriba y quedará disponible."}
            </p>
          ) : (
          <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <ul className="divide-y divide-cos-line">
              {acusesFiltrados.map((a) => (
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
          )}
        </div>
      )}
    </div>
  );
}
