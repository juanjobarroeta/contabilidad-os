"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ScrollText, AlertCircle } from "lucide-react";
import { etiquetaAccion, resumenDetalle } from "@/lib/audit-format";

interface EntradaBitacora {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  accion: string;
  entidad: string | null;
  entidadId: string | null;
  detalle: unknown;
  ip: string | null;
}

// Bitácora de seguridad de la empresa (sólo OWNER/ADMIN; para otros roles el
// endpoint responde 403 y el panel no se muestra). Lista de sólo lectura:
// las filas se registran automáticamente y no pueden editarse ni borrarse.
export function BitacoraPanel({ companyId }: { companyId: string }) {
  const [entradas, setEntradas] = useState<EntradaBitacora[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/bitacora?take=20`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        setError("No se pudo cargar la bitácora");
        return;
      }
      const data = await res.json();
      setEntradas(data.items ?? []);
      setNextCursor(data.nextCursor ?? null);
    } catch {
      setError("No se pudo cargar la bitácora");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/companies/${companyId}/bitacora?take=20&cursor=${encodeURIComponent(nextCursor)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setEntradas((prev) => [...prev, ...(data.items ?? [])]);
      setNextCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  }

  // Roles sin permiso de gobierno (ACCOUNTANT/VIEWER) no ven el panel.
  if (forbidden) return null;

  return (
    <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
      <div className="flex items-center gap-2 mb-1">
        <ScrollText className="h-4 w-4 text-cos-brand-ink" />
        <h2 className="font-semibold text-sm">Bitácora de seguridad</h2>
      </div>
      <p className="text-xs text-cos-ink-soft mb-4">
        Registro inmutable de las acciones sensibles sobre esta empresa:
        timbrado y cancelación de CFDI, dispersión de nómina, cambios de
        credenciales, gestión de miembros y acciones confirmadas del asistente.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : entradas.length === 0 ? (
        <p className="text-xs text-cos-ink-soft py-2">
          Aún no hay eventos registrados para esta empresa.
        </p>
      ) : (
        <div className="border border-cos-line rounded-lg divide-y divide-border">
          {entradas.map((e) => {
            const resumen = resumenDetalle(e.detalle);
            return (
              <div key={e.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <p className="text-sm flex-1 min-w-0 truncate">
                    {etiquetaAccion(e.accion)}
                  </p>
                  <span className="text-xs text-cos-ink-soft shrink-0">
                    {new Date(e.createdAt).toLocaleString("es-MX", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </div>
                <p className="text-xs text-cos-ink-soft truncate">
                  {e.actorEmail ?? "Sistema"}
                  {resumen ? ` · ${resumen}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {nextCursor && !loading && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-3 w-full border border-cos-line rounded-md py-2 text-xs text-cos-ink-soft hover:bg-cos-paper disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Cargar más
        </button>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-cos-red-ink mt-2">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </p>
      )}
    </section>
  );
}
