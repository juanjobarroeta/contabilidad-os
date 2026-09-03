"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Banner de Carta Manifiesto pendiente, para las pantallas de facturación.
//
// Sin la carta firmada, Facturapi no timbra en producción — pero el usuario se
// enteraba hasta que el timbrado le fallaba con un 422. Este banner consulta el
// estado VIVO de la organización en Facturapi (el mismo endpoint que usa la
// página de Empresa) y avisa ANTES de capturar la factura, con el enlace para
// firmarla. La carta se firma con la e.firma en el portal de Facturapi: las
// llaves nunca pasan por nuestra app, así que no hay flujo interno que ofrecer.
//
// Silencioso por diseño en todo lo demás: mientras carga, si el endpoint falla
// o si la organización ni siquiera existe (ese caso ya lo cubren los avisos de
// configuración de Facturapi), no pinta nada — su única voz es «falta la carta».
//
// El estado se cachea en sessionStorage (10 min) para no pegarle al API de
// Facturapi en cada navegación entre Facturas y Nueva factura.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const cacheKey = (companyId: string) => `manifiesto-status:${companyId}`;

interface EstadoFacturapi {
  orgId: string | null;
  pendingSteps?: Array<{ type: string; description: string }>;
}

function leerCache(companyId: string): EstadoFacturapi | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(companyId));
    if (!raw) return null;
    const { at, estado } = JSON.parse(raw) as { at: number; estado: EstadoFacturapi };
    return Date.now() - at < CACHE_TTL_MS ? estado : null;
  } catch {
    return null;
  }
}

function guardarCache(companyId: string, estado: EstadoFacturapi) {
  try {
    sessionStorage.setItem(cacheKey(companyId), JSON.stringify({ at: Date.now(), estado }));
  } catch {
    /* sessionStorage lleno o bloqueado: el banner sigue funcionando sin cache */
  }
}

export function ManifiestoBanner({ companyId }: { companyId: string }) {
  const [estado, setEstado] = useState<EstadoFacturapi | null>(null);

  useEffect(() => {
    let cancelado = false;
    const cacheado = leerCache(companyId);
    if (cacheado) {
      setEstado(cacheado);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/companies/${companyId}/facturapi/status`);
        if (!res.ok) return; // 502 de Facturapi o sin acceso: sin banner
        const j = (await res.json()) as EstadoFacturapi;
        if (cancelado) return;
        guardarCache(companyId, j);
        setEstado(j);
      } catch {
        /* red caída: sin banner */
      }
    })();
    return () => { cancelado = true; };
  }, [companyId]);

  const faltaManifiesto =
    !!estado?.orgId && (estado.pendingSteps ?? []).some((s) => s.type === "manifiesto");
  if (!faltaManifiesto) return null;

  return (
    <div className="mt-4 flex flex-wrap items-start gap-3 rounded-card border border-cos-amber-ink/25 bg-cos-amber-tint px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-cos-amber-ink" />
      {/* min-w-[16rem] y no min-w-0: con min-w-0 el texto se aplastaba a una
          palabra por línea en móvil (flex-wrap nunca envolvía porque la
          columna "cabía" encogida); con un mínimo real, los botones bajan de
          renglón. */}
      <div className="min-w-[16rem] flex-1 text-sm text-cos-amber-ink">
        <p className="font-semibold">Falta firmar la Carta Manifiesto de Facturapi.</p>
        <p className="mt-0.5 text-[13px]">
          Sin ella, tus facturas no se pueden timbrar ante el SAT. Se firma una sola vez con tu
          e.firma (.cer, .key y contraseña) directamente en el portal seguro de Facturapi — tus
          llaves nunca pasan por esta app.
        </p>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2">
        <a
          href="https://www.facturapi.io/manifiesto"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-control bg-cos-amber-ink px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90"
        >
          Firmar Carta Manifiesto <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <Link
          href="/empresa"
          className="rounded-control border border-cos-amber-ink/30 px-3 py-1.5 text-[12.5px] font-medium text-cos-amber-ink hover:bg-cos-card"
        >
          Ver configuración
        </Link>
      </div>
    </div>
  );
}
