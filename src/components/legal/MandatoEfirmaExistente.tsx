"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

type MandatoStatus = {
  documento: "MANDATO_EFIRMA";
  version: string;
  url: string;
  vigente: boolean;
  aceptadaPorUsuario: boolean;
  estadoCredencial:
    | "LISTA"
    | "SIN_EFIRMA"
    | "INCOMPLETA"
    | "REQUIERE_REENCRIPTACION";
  puedeAceptar: boolean;
  role: "OWNER" | "ADMIN" | "ACCOUNTANT" | "VIEWER";
};

export function MandatoEfirmaExistente({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<MandatoStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const companyGeneration = useRef(0);

  useEffect(() => {
    const generation = ++companyGeneration.current;
    const controller = new AbortController();
    setLoading(true);
    setAccepting(false);
    setStatus(null);
    setError("");
    setAcknowledged(false);
    void fetch(`/api/companies/${companyId}/mandato-efirma`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error ?? "No se pudo consultar la autorización.");
        }
        if (generation === companyGeneration.current) {
          setStatus(body as MandatoStatus);
        }
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (generation === companyGeneration.current) {
          setError(cause instanceof Error
            ? cause.message
            : "No se pudo consultar la autorización.");
        }
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          generation === companyGeneration.current
        ) {
          setLoading(false);
        }
      });
    return () => {
      ++companyGeneration.current;
      controller.abort();
    };
  }, [companyId]);

  async function accept() {
    if (!status || !acknowledged || accepting) return;
    const generation = companyGeneration.current;
    const targetCompanyId = companyId;
    setAccepting(true);
    setError("");
    try {
      const response = await fetch(
        `/api/companies/${targetCompanyId}/mandato-efirma`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            acepta: true,
            version: status.version,
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "No se pudo registrar la autorización.");
      }
      if (generation !== companyGeneration.current) return;
      setStatus((current) => current
        ? {
            ...current,
            vigente: true,
            aceptadaPorUsuario: true,
            puedeAceptar: false,
          }
        : current);
      setAcknowledged(false);
    } catch (cause) {
      if (generation === companyGeneration.current) {
        setError(cause instanceof Error
          ? cause.message
          : "No se pudo registrar la autorización.");
      }
    } finally {
      if (generation === companyGeneration.current) setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cos-line px-3 py-2 text-xs text-cos-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Verificando autorización vigente…
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-xs text-cos-red-ink">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {error}
      </div>
    );
  }
  if (!status || status.estadoCredencial === "SIN_EFIRMA") return null;

  if (status.vigente) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-2 text-xs text-cos-jade-ink">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Autorización de uso de la e.firma vigente (versión {status.version}).
        </span>
      </div>
    );
  }

  if (status.estadoCredencial !== "LISTA") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-xs text-cos-amber-ink">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        La e.firma almacenada no tiene los tres campos cifrados requeridos.
        Vuelve a cargarla para registrar una autorización válida.
      </div>
    );
  }

  if (!status.puedeAceptar) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-xs text-cos-amber-ink">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Falta la autorización vigente. Debe aceptarla un OWNER, ADMIN o
          ACCOUNTANT facultado; un usuario de solo lectura o soporte de
          plataforma no puede aceptarla por el cliente.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-3 text-xs text-cos-amber-ink">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label="Acepto la Autorización de uso de la e.firma vigente"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5"
        />
        <span className="leading-relaxed">
          Declaro que estoy facultado para usar la e.firma almacenada de esta
          empresa y acepto la{" "}
          <a
            href={status.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-cos-brand-ink hover:underline"
          >
            Autorización de uso de la e.firma
          </a>
          {" "}(versión {status.version}) sin reemplazar las credenciales.
        </span>
      </div>
      {error && (
        <p className="flex items-start gap-1.5 text-cos-red-ink">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      <button
        type="button"
        onClick={accept}
        disabled={!acknowledged || accepting}
        className="inline-flex items-center gap-2 rounded-md bg-cos-brand px-3 py-1.5 font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
      >
        {accepting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <ShieldCheck className="h-3.5 w-3.5" />}
        {accepting ? "Registrando…" : "Registrar autorización vigente"}
      </button>
    </div>
  );
}
