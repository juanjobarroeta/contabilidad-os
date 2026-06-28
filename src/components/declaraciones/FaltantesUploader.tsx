"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Captura de acuses faltantes, reutilizable. Agrupa las mensuales (ISR
// provisional + IVA del mismo periodo se presentan en UN acuse) en una fila que
// un solo upload resuelve; las anuales van una por ejercicio. Lee el PDF con el
// extractor y guarda cada obligación de la fila desde el mismo documento.
// Se usa en /declaraciones (todas las empresas) y en el banner del Workspace
// (una empresa, compact).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { CheckCircle2, Loader2, UploadCloud, AlertCircle, Building2 } from "lucide-react";

export type Faltante = {
  companyId: string;
  tipo: "DECLARACION_ANUAL" | "IVA_MENSUAL" | "ISR_PROVISIONAL";
  periodo: string;
  etiqueta: string;
  motivo: string;
};
export type EmpresaCobertura = {
  companyId: string;
  rfc: string;
  razonSocial: string;
  faltantes: Faltante[];
};

const TIPO_LABEL: Record<string, string> = {
  DECLARACION_ANUAL: "Anual",
  IVA_MENSUAL: "IVA",
  ISR_PROVISIONAL: "ISR prov.",
};
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(f);
  });

interface Item {
  key: string;
  companyId: string;
  periodo: string;
  etiqueta: string;
  motivo: string;
  tipos: Faltante["tipo"][];
  kind: "anual" | "mensual";
}
function agrupar(companyId: string, faltantes: Faltante[]): Item[] {
  const items: Item[] = [];
  for (const f of faltantes.filter((x) => x.tipo === "DECLARACION_ANUAL")) {
    items.push({
      key: `${companyId}:DECLARACION_ANUAL:${f.periodo}`,
      companyId, periodo: f.periodo, etiqueta: f.etiqueta, motivo: f.motivo,
      tipos: ["DECLARACION_ANUAL"], kind: "anual",
    });
  }
  const porPeriodo = new Map<string, Faltante[]>();
  for (const f of faltantes.filter((x) => x.tipo !== "DECLARACION_ANUAL")) {
    porPeriodo.set(f.periodo, [...(porPeriodo.get(f.periodo) ?? []), f]);
  }
  for (const [periodo, fs] of porPeriodo) {
    const [y, m] = periodo.split("-");
    const cubre = fs.map((f) => TIPO_LABEL[f.tipo]).join(" + ");
    items.push({
      key: `${companyId}:MENSUAL:${periodo}`,
      companyId, periodo,
      etiqueta: `Declaración mensual ${MESES[parseInt(m, 10) - 1] ?? m} ${y}`,
      motivo: `Acuse mensual — cubre ${cubre}.${fs.length > 1 ? " Un mismo acuse cubre ambos." : ""} Alimenta el arrastre (saldos a favor, pagos provisionales).`,
      tipos: fs.map((f) => f.tipo), kind: "mensual",
    });
  }
  return items.sort((a, b) =>
    a.kind === b.kind
      ? (a.kind === "anual" ? a.periodo.localeCompare(b.periodo) : b.periodo.localeCompare(a.periodo))
      : a.kind === "anual" ? -1 : 1
  );
}

export function FaltantesUploader({
  empresas,
  onUploaded,
  compact = false,
}: {
  empresas: EmpresaCobertura[];
  onUploaded?: () => void;
  compact?: boolean;
}) {
  // estado por fila: "idle" | "subiendo" | "ok" | "error:<msg>"
  const [estado, setEstado] = useState<Record<string, string>>({});

  async function subir(item: Item, file: File) {
    const k = item.key;
    setEstado((s) => ({ ...s, [k]: "subiendo" }));
    try {
      const form = new FormData();
      form.append("file", file);
      const pres = await fetch("/api/onboarding/parse-document", { method: "POST", body: form });
      const parsed = await pres.json();
      if (!pres.ok) throw new Error(parsed.error || "No se pudo leer el PDF");

      const acuse = item.kind === "anual" ? parsed.extracted?.acuseAnual : parsed.extracted?.acuseMensual;
      if (!acuse) {
        throw new Error(
          item.kind === "anual"
            ? "El PDF no se detectó como acuse de declaración anual."
            : "El PDF no se detectó como acuse de la declaración mensual."
        );
      }

      const pdfBase64 = await fileToBase64(file);
      for (const tipo of item.tipos) {
        const sres = await fetch("/api/declaraciones/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: item.companyId,
            tipo,
            periodo: item.periodo,
            pdfBase64,
            filename: file.name,
            acuse,
          }),
        });
        const saved = await sres.json();
        if (!sres.ok) throw new Error(saved.error || "No se pudo guardar");
      }
      setEstado((s) => ({ ...s, [k]: "ok" }));
      onUploaded?.();
    } catch (e) {
      setEstado((s) => ({ ...s, [k]: `error:${e instanceof Error ? e.message : "Error"}` }));
    }
  }

  return (
    <div className={compact ? "space-y-3" : "space-y-5"}>
      {empresas.map((emp) => {
        const items = agrupar(emp.companyId, emp.faltantes);
        if (items.length === 0) return null;
        return (
          <div key={emp.companyId} className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            {!compact && (
              <div className="flex items-center gap-2 border-b border-cos-line bg-cos-paper px-4 py-2.5">
                <Building2 className="h-4 w-4 text-cos-ink-faint" />
                <span className="text-sm font-semibold text-cos-ink">{emp.razonSocial}</span>
                <span className="font-mono text-[11px] text-cos-ink-faint">{emp.rfc}</span>
                <span className="ml-auto text-[12px] text-cos-ink-faint">{items.length} por subir</span>
              </div>
            )}
            <ul className="divide-y divide-cos-line">
              {items.map((item) => {
                const st = estado[item.key] ?? "idle";
                const done = st === "ok";
                const err = st.startsWith("error:");
                return (
                  <li key={item.key} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-cos-ink">
                        {item.etiqueta}
                        {item.tipos.map((t) => (
                          <span key={t} className="rounded-full bg-cos-paper px-1.5 py-0.5 text-[10px] font-medium text-cos-ink-soft">{TIPO_LABEL[t]}</span>
                        ))}
                      </p>
                      <p className="text-[12px] text-cos-ink-faint">{item.motivo}</p>
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
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep focus-within:outline-none focus-within:ring-2 focus-within:ring-cos-brand-tint">
                        <UploadCloud className="h-3.5 w-3.5" /> Subir acuse (PDF)
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) subir(item, file);
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
        );
      })}
    </div>
  );
}
