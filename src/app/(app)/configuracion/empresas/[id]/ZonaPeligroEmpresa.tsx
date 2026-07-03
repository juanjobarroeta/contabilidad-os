"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

/**
 * Zona de peligro — baja definitiva de la empresa (LFPDPPP, derecho de
 * cancelación). Flujo inline: botón destructivo → confirmación con RFC
 * escrito exactamente + casilla de irreversibilidad → DELETE → redirección.
 * Solo el OWNER directo de la empresa puede completar la baja (el API
 * responde 403 en cualquier otro caso).
 */
export function ZonaPeligroEmpresa({ companyId, rfc }: { companyId: string; rfc: string }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmRfc, setConfirmRfc] = useState("");
  const [entiendo, setEntiendo] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [error, setError] = useState("");

  const coincide = confirmRfc.trim().toUpperCase() === rfc.trim().toUpperCase();

  async function handleEliminar() {
    if (!coincide || !entiendo) return;
    setEliminando(true);
    setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmRfc: confirmRfc.trim().toUpperCase() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo eliminar la empresa");
      }
      // Recarga completa: limpia cualquier estado de cliente ligado a la
      // empresa activa que acaba de dejar de existir.
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setEliminando(false);
    }
  }

  return (
    <section className="bg-cos-card border border-cos-red-ink/30 rounded-xl shadow-sm p-5 mb-5">
      <h2 className="font-semibold text-sm mb-2 flex items-center gap-2 text-cos-red-ink">
        <AlertTriangle className="h-4 w-4" />
        Zona de peligro
      </h2>
      <p className="text-xs text-cos-ink-soft mb-3">
        Eliminar esta empresa borra de forma <strong>definitiva e irreversible</strong> todos sus
        datos de la plataforma: CFDIs, movimientos bancarios, nómina, declaraciones, contabilidad
        electrónica y las credenciales almacenadas (e.firma, CSD). Las credenciales se destruyen
        de inmediato al iniciar la baja.
      </p>

      {!abierto ? (
        <button
          onClick={() => setAbierto(true)}
          className="flex items-center gap-2 border border-cos-red-ink/40 text-cos-red-ink px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-red-tint"
        >
          <Trash2 className="h-4 w-4" />
          Eliminar empresa definitivamente
        </button>
      ) : (
        <div className="border border-cos-red-ink/20 bg-cos-red-tint/40 rounded-lg p-4 space-y-3">
          <p className="text-xs text-cos-ink">
            <strong>Importante:</strong> conforme al Art. 30 del CFF, el contribuyente está
            obligado a conservar su contabilidad y documentación fiscal durante 5 años. Al
            eliminar la empresa, esos documentos desaparecen de la plataforma — te recomendamos{" "}
            <Link href="/facturas" className="underline font-medium">
              exportar tus facturas
            </Link>{" "}
            antes de continuar.
          </p>
          <div>
            <label className="block text-xs font-medium mb-1">
              Escribe el RFC de la empresa (<span className="font-mono">{rfc}</span>) para
              confirmar
            </label>
            <input
              type="text"
              value={confirmRfc}
              onChange={(e) => setConfirmRfc(e.target.value.toUpperCase())}
              placeholder={rfc}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-red-ink/30"
            />
          </div>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={entiendo}
              onChange={(e) => setEntiendo(e.target.checked)}
              className="mt-0.5"
            />
            <span>Entiendo que esta acción es irreversible.</span>
          </label>
          {error && <p className="text-xs text-cos-red-ink">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleEliminar}
              disabled={!coincide || !entiendo || eliminando}
              className="flex items-center gap-2 bg-cos-red-ink text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {eliminando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {eliminando ? "Eliminando…" : "Eliminar definitivamente"}
            </button>
            <button
              onClick={() => {
                setAbierto(false);
                setConfirmRfc("");
                setEntiendo(false);
                setError("");
              }}
              disabled={eliminando}
              className="px-4 py-2 rounded-md text-sm text-cos-ink-soft hover:text-cos-ink"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
