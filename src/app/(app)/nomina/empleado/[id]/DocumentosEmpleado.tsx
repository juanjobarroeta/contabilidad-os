"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Expediente documental del empleado — contratos, CURP, NSS, INE, otros.
//
// La API existía (GET/POST /api/nomina/empleado/[id]/documentos, descarga por
// [docId]) y el parser también (parse-employee-docs lee un contrato en PDF);
// no había dónde subir ni ver nada. Aquí: lista con descarga, zona de subida
// con tipo, y —al subir un CONTRATO— se pasa por el parser y lo extraído se
// ofrece como SUGERENCIA con diff contra lo capturado: «el contrato dice SBC
// $315.59, tienes $300.00 · [aplicar]». Nunca se aplica solo.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Upload, Download, Trash2, Loader2, Wand2, Check, X } from "lucide-react";
import { Card } from "@/components/ui";
import { descargarUrl } from "@/lib/descargar";
import { formatCurrency, formatDate } from "@/lib/utils";

type Doc = { id: string; tipo: string; nombre: string; mime: string; bytes: number; createdAt: string };

const TIPOS: { id: string; label: string }[] = [
  { id: "CONTRATO", label: "Contrato" },
  { id: "CURP", label: "CURP" },
  { id: "NSS", label: "Constancia NSS" },
  { id: "INE", label: "Identificación" },
  { id: "ALTA_IMSS", label: "Alta IMSS" },
  { id: "OTRO", label: "Otro" },
];
const TIPO_LABEL = Object.fromEntries(TIPOS.map((t) => [t.id, t.label]));

/** Lo que el parser puede sugerir y el PATCH de empleados acepta. */
type Sugerencia = { campo: "salarioDiario" | "salarioDiarioIntegrado" | "puesto" | "fechaIngreso"; label: string; actual: string; propuesto: string; valor: unknown };

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function DocumentosEmpleado({
  employeeId, companyId, ficha, onFichaChanged,
}: {
  employeeId: string;
  companyId: string;
  /** Lo capturado hoy, para el diff de sugerencias. */
  ficha: { salarioDiario: number; salarioDiarioIntegrado: number | null; puesto: string | null; fechaIngreso: string };
  onFichaChanged: () => void;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [tipo, setTipo] = useState("CONTRATO");
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState("");
  const [sugerencias, setSugerencias] = useState<Sugerencia[]>([]);
  const [aplicando, setAplicando] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/nomina/empleado/${employeeId}/documentos`);
    if (res.ok) setDocs((await res.json()).documentos ?? []);
    else setDocs([]);
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);

  async function subir(file: File) {
    setError(""); setSugerencias([]); setSubiendo(true);
    try {
      const base64 = await new Promise<string>((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(",")[1] ?? "");
        r.onerror = () => ko(new Error("No se pudo leer el archivo"));
        r.readAsDataURL(file);
      });
      const res = await fetch(`/api/nomina/empleado/${employeeId}/documentos`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, nombre: file.name, mime: file.type, base64 }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({})))?.error ?? "No se pudo subir"); return; }
      await load();
      // Un contrato en PDF además se LEE: lo extraído se ofrece, no se aplica.
      if (tipo === "CONTRATO" && file.type === "application/pdf") {
        const fd = new FormData(); fd.append("file", file); fd.append("companyId", companyId);
        const p = await fetch("/api/nomina/parse-employee-docs", { method: "POST", body: fd });
        if (p.ok) {
          const d = await p.json();
          const ex = (d.data ?? d.extracted ?? d) as Record<string, unknown>;
          const out: Sugerencia[] = [];
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          const sd = num(ex.salarioDiario);
          if (sd != null && Math.abs(sd - ficha.salarioDiario) > 0.005) out.push({ campo: "salarioDiario", label: "Salario diario", actual: formatCurrency(ficha.salarioDiario), propuesto: formatCurrency(sd), valor: sd });
          const sdi = num(ex.salarioDiarioIntegrado);
          if (sdi != null && Math.abs(sdi - (ficha.salarioDiarioIntegrado ?? 0)) > 0.005) out.push({ campo: "salarioDiarioIntegrado", label: "SDI (SBC)", actual: ficha.salarioDiarioIntegrado != null ? formatCurrency(ficha.salarioDiarioIntegrado) : "—", propuesto: formatCurrency(sdi), valor: sdi });
          if (typeof ex.puesto === "string" && ex.puesto.trim() && ex.puesto.trim().toUpperCase() !== (ficha.puesto ?? "").trim().toUpperCase()) out.push({ campo: "puesto", label: "Puesto", actual: ficha.puesto ?? "—", propuesto: ex.puesto.trim(), valor: ex.puesto.trim() });
          if (typeof ex.fechaIngreso === "string" && /^\d{4}-\d{2}-\d{2}/.test(ex.fechaIngreso) && ex.fechaIngreso.slice(0, 10) !== ficha.fechaIngreso.slice(0, 10)) out.push({ campo: "fechaIngreso", label: "Fecha de ingreso", actual: formatDate(ficha.fechaIngreso), propuesto: formatDate(ex.fechaIngreso), valor: ex.fechaIngreso.slice(0, 10) });
          setSugerencias(out);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo subir");
    } finally {
      setSubiendo(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function aplicar(s: Sugerencia) {
    setAplicando(s.campo);
    try {
      const res = await fetch("/api/empleados", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, companyId, [s.campo]: s.valor }),
      });
      if (res.ok) { setSugerencias((prev) => prev.filter((x) => x.campo !== s.campo)); onFichaChanged(); }
      else setError((await res.json().catch(() => ({})))?.error ?? "No se pudo aplicar");
    } finally { setAplicando(null); }
  }

  async function borrar(d: Doc) {
    if (!confirm(`¿Eliminar «${d.nombre}» del expediente?`)) return;
    const res = await fetch(`/api/nomina/empleado/${employeeId}/documentos/${d.id}`, { method: "DELETE" });
    if (res.ok) await load(); else setError("No se pudo eliminar");
  }

  return (
    <>
      <h2 className="mt-8 flex items-center gap-2 text-[16px] font-semibold text-cos-ink">
        <FileText className="h-[18px] w-[18px] text-cos-ink-faint" /> Documentos
      </h2>
      <Card className="mt-3 rounded-card border-cos-line p-5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo de documento"
            className="rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink">
            {TIPOS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <input ref={inputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,application/xml,text/xml" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); }} />
          <button onClick={() => inputRef.current?.click()} disabled={subiendo}
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Subir {TIPO_LABEL[tipo].toLowerCase()}
          </button>
          {tipo === "CONTRATO" && (
            <span className="inline-flex items-center gap-1 text-[12px] text-cos-ink-faint"><Wand2 className="h-3.5 w-3.5" /> un contrato en PDF se lee y te sugiere cambios</span>
          )}
        </div>
        {error && <p className="mt-2 text-[12.5px] text-cos-red-ink">{error}</p>}

        {sugerencias.length > 0 && (
          <div className="mt-3 rounded-control border border-cos-amber/40 bg-cos-amber-tint/40 px-3.5 py-2.5">
            <p className="text-[12.5px] font-semibold text-cos-amber-ink">El contrato dice algo distinto a lo capturado</p>
            <ul className="mt-1.5 space-y-1">
              {sugerencias.map((s) => (
                <li key={s.campo} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className="text-cos-ink-soft">{s.label}:</span>
                  <span className="font-mono text-cos-ink-faint line-through">{s.actual}</span>
                  <span className="font-mono font-medium text-cos-ink">{s.propuesto}</span>
                  <button onClick={() => aplicar(s)} disabled={aplicando === s.campo}
                    className="inline-flex items-center gap-1 rounded-control border border-cos-line bg-cos-card px-2 py-0.5 text-[12px] font-semibold text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink disabled:opacity-50">
                    {aplicando === s.campo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Aplicar
                  </button>
                  <button onClick={() => setSugerencias((p) => p.filter((x) => x.campo !== s.campo))} title="Descartar" className="text-cos-ink-faint hover:text-cos-ink"><X className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {docs === null ? (
          <p className="mt-3 text-[13px] text-cos-ink-faint">Cargando…</p>
        ) : docs.length === 0 ? (
          <p className="mt-3 text-[13px] text-cos-ink-faint">Sin documentos todavía. Empieza por el contrato.</p>
        ) : (
          <ul className="mt-3 divide-y divide-cos-line-soft">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-semibold text-cos-ink-soft">{TIPO_LABEL[d.tipo] ?? d.tipo}</span>
                <span className="min-w-0 flex-1 truncate text-cos-ink" title={d.nombre}>{d.nombre}</span>
                <span className="font-mono text-[11.5px] text-cos-ink-faint">{kb(d.bytes)} · {formatDate(d.createdAt)}</span>
                <button onClick={() => descargarUrl(`/api/nomina/empleado/${employeeId}/documentos/${d.id}`, d.nombre)} title="Descargar" className="text-cos-ink-soft hover:text-cos-brand-ink"><Download className="h-4 w-4" /></button>
                <button onClick={() => borrar(d)} title="Eliminar" className="text-cos-ink-faint hover:text-cos-red-ink"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
