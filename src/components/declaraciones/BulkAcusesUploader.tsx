"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Subida EN BOLSA de acuses: sueltas todos los PDFs y el software clasifica.
//
// Caso real que lo motiva: un solo mes del SAT llega como VARIOS documentos
// (el acuse corto con ISR+IVA, el transcript de ISR de 13 hojas y la
// declaración de IEPS aparte). Pedirle al usuario que decida qué archivo va
// en qué renglón es trabajo nuestro, no suyo.
//
// Por archivo: parse con Claude (mismo parser del onboarding) → el periodo
// sale del documento y los TIPOS se derivan de los datos presentes (campos de
// IVA / ISR / IEPS / anual no nulos) → un save por tipo con el PDF adjunto
// (upsert por companyId+tipo+periodo: re-subir reemplaza). Cada archivo
// reporta dónde aterrizó o por qué no se pudo.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";

interface Resultado {
  archivo: string;
  estado: "procesando" | "ok" | "error";
  detalle: string;
}

const LBL: Record<string, string> = {
  DECLARACION_ANUAL: "Anual",
  IVA_MENSUAL: "IVA",
  ISR_PROVISIONAL: "ISR",
  IEPS_MENSUAL: "IEPS",
};

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(f);
  });

export function BulkAcusesUploader({
  companyId,
  onUploaded,
}: {
  companyId: string;
  onUploaded?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [busy, setBusy] = useState(false);

  async function procesarArchivo(file: File): Promise<Resultado> {
    const form = new FormData();
    form.append("file", file);
    const pres = await fetch("/api/onboarding/parse-document", { method: "POST", body: form });
    const parsed = await pres.json().catch(() => null);
    if (!pres.ok) {
      return { archivo: file.name, estado: "error", detalle: parsed?.error ?? "No se pudo leer el PDF" };
    }

    const pdfBase64 = await fileToBase64(file);

    // Anual: un save directo por ejercicio.
    const anual = parsed?.extracted?.acuseAnual;
    if (parsed?.type === "ACUSE_ANUAL" && anual?.ejercicio) {
      const res = await fetch("/api/declaraciones/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          tipo: "DECLARACION_ANUAL",
          periodo: String(anual.ejercicio),
          pdfBase64,
          filename: file.name,
          acuse: anual,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        return { archivo: file.name, estado: "error", detalle: d?.error ?? "No se pudo guardar" };
      }
      return { archivo: file.name, estado: "ok", detalle: `Anual ${anual.ejercicio}` };
    }

    // Mensual: los tipos salen de los DATOS presentes en el documento.
    const m = parsed?.extracted?.acuseMensual;
    if (!m) {
      return {
        archivo: file.name,
        estado: "error",
        detalle: "No se detectó como acuse de declaración (¿es otro documento?)",
      };
    }
    if (!m.periodoMes || !m.periodoAnio) {
      return { archivo: file.name, estado: "error", detalle: "No pude leer el periodo (mes/año) del documento" };
    }
    const periodo = `${m.periodoAnio}-${String(m.periodoMes).padStart(2, "0")}`;

    const tipos: string[] = [];
    if (m.ivaAPagar != null || m.ivaCausado != null || m.ivaAcreditable != null || m.ivaAFavor != null)
      tipos.push("IVA_MENSUAL");
    if (m.isrAPagar != null || m.isrIngresos != null) tipos.push("ISR_PROVISIONAL");
    if (m.iepsAPagar != null || m.iepsAFavor != null) tipos.push("IEPS_MENSUAL");
    if (tipos.length === 0) {
      return {
        archivo: file.name,
        estado: "error",
        detalle: `Acuse de ${periodo} sin montos legibles de IVA/ISR/IEPS`,
      };
    }

    for (const tipo of tipos) {
      const res = await fetch("/api/declaraciones/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, tipo, periodo, pdfBase64, filename: file.name, acuse: m }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        return { archivo: file.name, estado: "error", detalle: d?.error ?? `No se pudo guardar ${LBL[tipo]}` };
      }
    }
    return {
      archivo: file.name,
      estado: "ok",
      detalle: `${periodo} · ${tipos.map((t) => LBL[t]).join(" + ")}`,
    };
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    setBusy(true);
    const lista = [...files];
    setResultados(lista.map((f) => ({ archivo: f.name, estado: "procesando", detalle: "Leyendo…" })));
    // Secuencial a propósito: cada parse es una llamada a Claude y el orden
    // hace legible el progreso archivo por archivo.
    for (let i = 0; i < lista.length; i++) {
      let r: Resultado;
      try {
        r = await procesarArchivo(lista[i]);
      } catch (e) {
        r = { archivo: lista[i].name, estado: "error", detalle: e instanceof Error ? e.message : "Error inesperado" };
      }
      setResultados((prev) => prev.map((p, j) => (j === i ? r : p)));
    }
    setBusy(false);
    onUploaded?.();
  }

  return (
    <div className="mt-4 rounded-card border border-dashed border-cos-line bg-cos-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[13.5px] font-semibold text-cos-ink">¿Muchos acuses? Súbelos todos de una vez</p>
          <p className="text-[12.5px] text-cos-ink-faint">
            Suelta aquí todos tus PDFs — leemos cada uno, detectamos el periodo y el impuesto (IVA, ISR, IEPS o
            anual) y los acomodamos donde van. Un mes puede venir en varios archivos; no importa el orden.
          </p>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-control bg-cos-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
        >
          <FileUp className="mr-1.5 inline h-4 w-4" />
          {busy ? "Procesando…" : "Elegir PDFs"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {resultados.length > 0 && (
        <div className="mt-3 space-y-1">
          {resultados.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-[12.5px]">
              {r.estado === "procesando" && <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-cos-ink-faint" />}
              {r.estado === "ok" && <CheckCircle2 className="h-3.5 w-3.5 flex-none text-cos-green-ink" />}
              {r.estado === "error" && <XCircle className="h-3.5 w-3.5 flex-none text-cos-red-ink" />}
              <span className="truncate font-medium text-cos-ink">{r.archivo}</span>
              <span className={`truncate ${r.estado === "error" ? "text-cos-red-ink" : "text-cos-ink-faint"}`}>
                {r.detalle}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
