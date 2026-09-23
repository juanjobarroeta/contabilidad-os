"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, NotebookPen, Plus, X } from "lucide-react";
import { tituloDeClave, TITULO_TEMA, type TemaExpediente } from "@/lib/expediente/claves";

// ─────────────────────────────────────────────────────────────────────────────
// EL EXPEDIENTE, DONDE SE USA.
//
// El expediente dejó la sidebar: como página suelta nadie sabía para qué era.
// Lo que sabemos de la terminal sirve en Bancos, el plazo de un cliente en el
// Directorio, el responsable del cierre en Mi Empresa. Esta tira enseña SÓLO
// las familias de hechos y los compromisos del tema de la pantalla donde vive,
// y deja anotar ahí mismo. La página /expediente sigue existiendo (la enlaza el
// rail del copiloto) para la bitácora completa.
//
// Lo que se anota aquí va por la misma ruta que la página: fuente «usuario»,
// verificado, intocable para motores y agente.
// ─────────────────────────────────────────────────────────────────────────────

interface Hecho {
  id: string;
  clave: string;
  familia: string;
  valor: unknown;
  fuente: string;
  verificado: boolean;
}

interface Pendiente {
  id: string;
  titulo: string;
  cuerpo: string;
  tema: TemaExpediente;
}

const texto = (v: unknown): string => {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(texto).join(", ");
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k}: ${texto(x)}`)
    .join("; ");
};

const INPUT =
  "rounded-control border border-cos-line bg-cos-card px-2 py-1 text-[12.5px] text-cos-ink placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none";
const MINI =
  "rounded-control border border-cos-line px-1.5 py-0.5 text-[11px] text-cos-ink-faint hover:border-cos-brand hover:text-cos-brand-ink";

export function ExpedienteEnContexto({
  companyId,
  titulo,
  familias,
  temas,
  claves,
  vacio,
  className = "",
}: {
  companyId: string;
  /** «Lo que sabemos de tus terminales y cuentas». */
  titulo: string;
  /** Prefijos de clave que esta pantalla enseña: ["terminal", "banco"]. */
  familias: string[];
  /** Temas cuyos compromisos abiertos se enseñan aquí. */
  temas: TemaExpediente[];
  /** Claves que se ofrecen al anotar, en orden. */
  claves: string[];
  /** Qué decir cuando no hay nada: por qué valdría la pena anotarlo. */
  vacio: string;
  className?: string;
}) {
  const [hechos, setHechos] = useState<Hecho[]>([]);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anotando, setAnotando] = useState(false);
  const [nuevo, setNuevo] = useState({ clave: claves[0] ?? "", valor: "" });
  const [guardando, setGuardando] = useState(false);

  const familiasKey = familias.join(",");
  const temasKey = temas.join(",");

  const cargar = useCallback(async () => {
    try {
      const res = await fetch(`/api/expediente?${new URLSearchParams({ companyId })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudo cargar el expediente");
      const fs = familiasKey.split(",");
      const ts = temasKey.split(",");
      setHechos(((data.hechos ?? []) as Hecho[]).filter((h) => fs.includes(h.familia)));
      setPendientes(((data.pendientes ?? []) as Pendiente[]).filter((p) => ts.includes(p.tema)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el expediente");
    } finally {
      setCargado(true);
    }
  }, [companyId, familiasKey, temasKey]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const llamar = useCallback(
    async (url: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
      setGuardando(true);
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, ...body }),
        });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string })?.error ?? "No se pudo guardar");
        await cargar();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo guardar");
        return false;
      } finally {
        setGuardando(false);
      }
    },
    [companyId, cargar],
  );

  // Hasta saber qué hay no se pinta nada: un «nada anotado» que luego se llena
  // sería un destello falso en cada entrada a la pantalla.
  if (!cargado) return null;

  return (
    <div className={`rounded-card border border-cos-line-soft bg-cos-paper px-3.5 py-2.5 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <NotebookPen className="h-3.5 w-3.5 flex-none text-cos-ink-faint" />
        <p className="text-[12px] font-semibold text-cos-ink-soft">{titulo}</p>
        <span className="ml-auto flex items-center gap-3">
          {!anotando && (
            <button
              type="button"
              onClick={() => setAnotando(true)}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-cos-brand-ink hover:underline"
            >
              <Plus className="h-3 w-3" /> Anotar
            </button>
          )}
          <Link href="/expediente" className="text-[11.5px] text-cos-ink-faint hover:text-cos-brand-ink hover:underline">
            Expediente completo →
          </Link>
        </span>
      </div>

      {error && <p className="mt-1.5 text-[12px] text-cos-red-ink">{error}</p>}

      {hechos.length === 0 && pendientes.length === 0 && !anotando && (
        <p className="mt-1 pl-[22px] text-[12px] text-cos-ink-faint">{vacio}</p>
      )}

      {hechos.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-[22px]">
          {hechos.map((h) => (
            <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
              <span className="text-cos-ink-soft">{tituloDeClave(h.clave)}:</span>
              <span className="font-semibold text-cos-ink">{texto(h.valor)}</span>
              {!h.verificado && <span className="text-[11px] text-cos-ink-faint">({h.fuente}, sin verificar)</span>}
              <span className="ml-auto flex gap-1">
                {!h.verificado && (
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() => void llamar(`/api/expediente/hechos/${h.id}`, "PATCH", { accion: "verificar" })}
                    className={MINI}
                    title="Confirmar este dato: ni el motor ni el copiloto lo vuelven a cambiar"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={guardando}
                  onClick={() => void llamar(`/api/expediente/hechos/${h.id}`, "PATCH", { accion: "cerrar" })}
                  className={MINI}
                  title="Dejó de ser cierto (no se borra: se le pone fecha de fin)"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {pendientes.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-[22px]">
          {pendientes.map((p) => (
            <li key={p.id} className="text-[12.5px]">
              <span className="font-semibold text-cos-amber-ink">Pendiente · {TITULO_TEMA[p.tema] ?? p.tema}:</span>{" "}
              <span className="text-cos-ink">{p.titulo}</span>
              {p.cuerpo && <span className="text-cos-ink-soft"> — {p.cuerpo}</span>}
            </li>
          ))}
        </ul>
      )}

      {anotando && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 pl-[22px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nuevo.clave || !nuevo.valor.trim()) return;
            void llamar("/api/expediente", "POST", { kind: "hecho", clave: nuevo.clave, valor: nuevo.valor }).then(
              (ok) => {
                if (!ok) return;
                setNuevo((s) => ({ ...s, valor: "" }));
                setAnotando(false);
              },
            );
          }}
        >
          <select
            className={INPUT}
            value={nuevo.clave}
            onChange={(e) => setNuevo((s) => ({ ...s, clave: e.target.value }))}
          >
            {claves.map((c) => (
              <option key={c} value={c}>
                {tituloDeClave(c)}
              </option>
            ))}
          </select>
          <input
            autoFocus
            className={`${INPUT} min-w-[12rem] flex-1`}
            placeholder="Lo que sabes, con tus palabras"
            value={nuevo.valor}
            onChange={(e) => setNuevo((s) => ({ ...s, valor: e.target.value }))}
          />
          <button
            type="submit"
            disabled={guardando || !nuevo.valor.trim()}
            className="rounded-control bg-cos-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
          >
            Guardar
          </button>
          <button
            type="button"
            onClick={() => setAnotando(false)}
            className="text-[12px] text-cos-ink-faint hover:text-cos-ink"
          >
            Cancelar
          </button>
        </form>
      )}
    </div>
  );
}
