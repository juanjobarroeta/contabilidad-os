"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FICHA «LO QUE FALTA» DEL RESOLVER — qué se está esperando por este movimiento.
//
// Es la ficha que contesta la pregunta que dejó un mes entero sin auditar: al
// seleccionar un depósito de terminal, en vez de una lista de candidatos que no
// cuadran, la mesa dice «falta el estado de cuenta de la terminal de julio, ya
// se pidió el 3 de agosto» — y deja recibirlo o cancelarlo ahí mismo.
//
// Se pinta ARRIBA de los candidatos cuando hay algo abierto: buscar con qué
// conciliar un lote cuyo respaldo no ha llegado es trabajo desperdiciado, y la
// mesa debe decirlo antes de invitar a hacerlo.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { etiquetaPeriodo, FICHA_TIPO, tituloDeTipo, type TipoSolicitud } from "@/lib/solicitudes/claves";

interface Solicitud {
  id: string;
  createdAt: string;
  tipo: TipoSolicitud;
  motivo: string;
  periodo: string | null;
  origen: string;
}

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[.08em] text-cos-ink-faint";

const diasDesde = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

function espera(iso: string): string {
  const d = diasDesde(iso);
  if (d <= 0) return "pedido hoy";
  if (d === 1) return "pedido ayer";
  return `pedido hace ${d} días`;
}

export function FichaSolicitudes({ companyId, txId }: { companyId: string; txId: string }) {
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch(`/api/solicitudes?companyId=${companyId}&entidadId=${txId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudo leer lo pendiente");
      setSolicitudes(data.solicitudes ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer lo pendiente");
    } finally {
      setCargando(false);
    }
  }, [companyId, txId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cerrar = useCallback(
    async (id: string, accion: "recibir" | "cancelar") => {
      const ref = window.prompt(
        accion === "recibir" ? "¿Qué llegó? (nombre del archivo, referencia…)" : "¿Por qué no aplica?",
      );
      if (ref === null) return;
      try {
        const res = await fetch(`/api/solicitudes/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, accion, ref: ref.trim() || null }),
        });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string })?.error ?? "No se pudo actualizar");
        await cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo actualizar");
      }
    },
    [companyId, cargar],
  );

  // Sin nada pendiente la ficha no se pinta: un recuadro que dice «no falta
  // nada» ocupa el mismo espacio que uno que sí avisa, y enseña a no mirarlos.
  if (cargando) return null;
  if (!error && solicitudes.length === 0) return null;

  return (
    <section className="rounded-card border border-cos-amber-tint bg-cos-card shadow-card">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <p className={EYEBROW}>Falta para poder cuadrar esto</p>
        {cargando && <Loader2 className="h-3.5 w-3.5 animate-spin text-cos-ink-faint" />}
      </div>

      {error && <p className="border-t border-cos-line-soft px-4 py-2.5 text-[12.5px] text-cos-red-ink">{error}</p>}

      <ul className="border-t border-cos-line-soft">
        {solicitudes.map((s) => (
          <li key={s.id} className="border-b border-cos-line-soft px-4 py-2.5 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold text-cos-ink">
                {tituloDeTipo(s.tipo)}
                {s.periodo ? ` · ${etiquetaPeriodo(s.periodo)}` : ""}
              </span>
              <span className="text-[11.5px] text-cos-ink-faint">
                {espera(s.createdAt)} · {s.origen === "motor" ? "lo detectó el sistema" : s.origen}
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">{s.motivo}</p>
            {FICHA_TIPO[s.tipo] && (
              <p className="mt-0.5 text-[11.5px] text-cos-ink-faint">
                Qué pedir: {FICHA_TIPO[s.tipo].quePedir}.
              </p>
            )}
            <div className="mt-1.5 flex gap-2">
              <button
                type="button"
                onClick={() => cerrar(s.id, "recibir")}
                className="rounded-control border border-cos-line bg-cos-card px-2.5 py-1 text-[12px] font-semibold text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink"
              >
                Ya llegó
              </button>
              <button
                type="button"
                onClick={() => cerrar(s.id, "cancelar")}
                className="rounded-control border border-cos-line px-2.5 py-1 text-[12px] text-cos-ink-faint hover:border-cos-red-ink hover:text-cos-red-ink"
              >
                No aplica
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
