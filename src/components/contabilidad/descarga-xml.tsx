"use client";

import { descargarBlob } from "@/lib/descargar";

// ─────────────────────────────────────────────────────────────────────────────
// Descarga de entregables del Anexo 24 con el error COMO GUÍA, no como archivo
// roto. Desde la ola «CE confiable», el servidor valida fail-closed (422 con
// detalles: CodAgrup fuera de la enum, póliza descuadrada, mes sin postear) —
// con un <a href> pelón ese JSON se descargaba como un .XML corrupto. Aquí el
// fetch intercepta el error y lo pinta accionable; el archivo bueno se entrega
// con el nombre exacto del Content-Disposition (convención SAT).
//
// También lee el diagnóstico de evidencia bancaria (X-Polizas-Sin-Evidencia):
// visible, no mudo — la regla de toda la ola.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Alert } from "@/components/ui/feedback";

export interface ErrorDescarga {
  mensaje: string;
  detalles: string[];
}

export interface DiagnosticoPolizas {
  bancarias: number;
  sinEvidencia: number;
}

export function useDescargaXml() {
  const [descargando, setDescargando] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDescarga | null>(null);
  const [diagnostico, setDiagnostico] = useState<DiagnosticoPolizas | null>(null);

  async function descargar(href: string) {
    setDescargando(href);
    setError(null);
    try {
      const res = await fetch(href);
      if (!res.ok) {
        let cuerpo: { error?: string; detalles?: string[] } | null = null;
        try {
          cuerpo = await res.json();
        } catch {
          /* respuesta no-JSON: mensaje genérico */
        }
        setError({
          mensaje: cuerpo?.error ?? `No se pudo generar el archivo (HTTP ${res.status}).`,
          detalles: cuerpo?.detalles ?? [],
        });
        return;
      }
      const bancarias = res.headers.get("X-Polizas-Bancarias");
      if (bancarias !== null) {
        setDiagnostico({
          bancarias: Number(bancarias),
          sinEvidencia: Number(res.headers.get("X-Polizas-Sin-Evidencia") ?? 0),
        });
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "entregable.xml";
      const blob = await res.blob();
      await descargarBlob(blob, filename); // PWA-consciente: hoja de compartir en standalone
    } catch {
      setError({ mensaje: "No se pudo descargar. Revisa tu conexión e intenta de nuevo.", detalles: [] });
    } finally {
      setDescargando(null);
    }
  }

  return { descargar, descargando, error, diagnostico, limpiarError: () => setError(null) };
}

/** El 422 del validador, pintado como lista accionable. */
export function ErroresDeValidacion({ error }: { error: ErrorDescarga | null }) {
  if (!error) return null;
  return (
    <Alert tone="danger" className="mb-3">
      <p className="font-semibold">{error.mensaje}</p>
      {error.detalles.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px]">
          {error.detalles.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Evidencia bancaria de las pólizas: cuántas salieron sin nodo Transferencia. */
export function DiagnosticoEvidencia({ diagnostico }: { diagnostico: DiagnosticoPolizas | null }) {
  if (!diagnostico || diagnostico.bancarias === 0) return null;
  if (diagnostico.sinEvidencia === 0) {
    return (
      <Alert tone="success" className="mb-3">
        Las {diagnostico.bancarias} pólizas bancarias del periodo llevan su evidencia de
        transferencia (banco, cuenta y RFC) — lo que el SAT revisa primero en un requerimiento.
      </Alert>
    );
  }
  return (
    <Alert tone="warning" className="mb-3">
      {diagnostico.sinEvidencia} de {diagnostico.bancarias} pólizas bancarias salieron sin nodo de
      transferencia: no se pudo resolver el banco de la contraparte con datos reales. Captura la
      CLABE de la contraparte en esos movimientos (Bancos → el movimiento → contraparte) y vuelve a
      generar.
    </Alert>
  );
}
