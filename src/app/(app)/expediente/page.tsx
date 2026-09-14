"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Check, X, RotateCcw } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card } from "@/components/ui";
import {
  TEMAS,
  TITULO_TEMA,
  TITULO_TIPO,
  tituloDeClave,
  type TemaExpediente,
  type TipoNota,
} from "@/lib/expediente/claves";

// ─────────────────────────────────────────────────────────────────────────────
// EL EXPEDIENTE DE LA EMPRESA — la página.
//
// Arriba los HECHOS vigentes, agrupados por familia; abajo la BITÁCORA, con los
// compromisos abiertos separados del resto. Es lo mismo que ve el copiloto en
// su system prompt: si la persona y el modelo leyeran cosas distintas, la
// memoria compartida dejaría de serlo.
//
// Lo que se captura aquí queda VERIFICADO: a partir de ese momento ni el motor
// ni el agente lo cambian. Ése es el único acto que convierte una inferencia en
// un dato, y por eso la página no es decorativa.
// ─────────────────────────────────────────────────────────────────────────────

interface Hecho {
  id: string;
  clave: string;
  familia: string;
  valor: unknown;
  fuente: string;
  vigenteDesde: string;
  confianza: string;
  verificado: boolean;
}

interface Nota {
  id: string;
  createdAt: string;
  autor: string;
  tipo: TipoNota;
  tema: TemaExpediente;
  titulo: string;
  cuerpo: string;
  refs: string[];
  estado: string;
}

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[.08em] text-cos-ink-faint";
const INPUT =
  "w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none";
const BTN =
  "inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12.5px] font-semibold text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink disabled:opacity-50";

const texto = (v: unknown): string => {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(texto).join(", ");
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k}: ${texto(x)}`)
    .join("; ");
};

const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export default function ExpedientePage() {
  const { activeCompany } = useCompany();
  const companyId = activeCompany?.id ?? null;

  const [hechos, setHechos] = useState<Hecho[]>([]);
  const [pendientes, setPendientes] = useState<Nota[]>([]);
  const [notas, setNotas] = useState<Nota[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tema, setTema] = useState<TemaExpediente | "">("");
  const [guardando, setGuardando] = useState(false);

  const [nuevoHecho, setNuevoHecho] = useState({ clave: "", valor: "" });
  const [nuevaNota, setNuevaNota] = useState<{ tipo: TipoNota; tema: TemaExpediente; titulo: string; cuerpo: string }>({
    tipo: "observacion",
    tema: "general",
    titulo: "",
    cuerpo: "",
  });

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ companyId });
      if (tema) qs.set("tema", tema);
      const res = await fetch(`/api/expediente?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudo cargar el expediente");
      setHechos(data.hechos ?? []);
      setPendientes(data.pendientes ?? []);
      setNotas(data.notas ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el expediente");
    } finally {
      setCargando(false);
    }
  }, [companyId, tema]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const enviar = useCallback(
    async (body: Record<string, unknown>) => {
      if (!companyId) return;
      setGuardando(true);
      try {
        const res = await fetch("/api/expediente", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, ...body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "No se pudo guardar");
        await cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo guardar");
      } finally {
        setGuardando(false);
      }
    },
    [companyId, cargar],
  );

  const patch = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      if (!companyId) return;
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, ...body }),
        });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string })?.error ?? "No se pudo actualizar");
        await cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo actualizar");
      }
    },
    [companyId, cargar],
  );

  const porFamilia = new Map<string, Hecho[]>();
  for (const h of hechos) porFamilia.set(h.familia, [...(porFamilia.get(h.familia) ?? []), h]);

  if (!companyId) {
    return <p className="p-6 text-[13px] text-cos-ink-soft">Selecciona una empresa para ver su expediente.</p>;
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-[20px] font-semibold text-cos-ink">Expediente</h1>
        <p className="mt-0.5 text-[13px] text-cos-ink-soft">
          Lo que sabemos de esta empresa y lo que se ha trabajado en ella. El copiloto lee exactamente esto.
        </p>
      </header>

      {error && <p className="rounded-control bg-cos-red-tint px-3 py-2 text-[12.5px] text-cos-red-ink">{error}</p>}

      {/* ── Hechos ─────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between px-4 py-2.5">
          <p className={EYEBROW}>Lo que sabemos del cliente</p>
          {cargando && <Loader2 className="h-3.5 w-3.5 animate-spin text-cos-ink-faint" />}
        </div>

        {!cargando && hechos.length === 0 && (
          <p className="border-t border-cos-line-soft px-4 py-3 text-[12.5px] text-cos-ink-faint">
            Nada registrado todavía. Lo que escribas aquí queda verificado y ni los motores ni el copiloto lo cambian.
          </p>
        )}

        {[...porFamilia.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([familia, lista]) => (
          <div key={familia} className="border-t border-cos-line-soft px-4 py-2.5">
            <p className="font-mono text-[11px] uppercase tracking-wide text-cos-ink-faint">{familia}</p>
            <ul className="mt-1 space-y-1.5">
              {lista.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] text-cos-ink-soft">{tituloDeClave(h.clave)}:</span>
                  <span className="text-[13px] font-semibold text-cos-ink">{texto(h.valor)}</span>
                  <span className="text-[11.5px] text-cos-ink-faint">
                    desde {fecha(h.vigenteDesde)} · {h.fuente}
                    {h.verificado ? "" : " · sin verificar"}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        patch(`/api/expediente/hechos/${h.id}`, {
                          accion: h.verificado ? "desverificar" : "verificar",
                        })
                      }
                      className="rounded-control border border-cos-line px-2 py-0.5 text-[11.5px] font-semibold text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink"
                      title={h.verificado ? "Quitar la confirmación" : "Confirmar este dato a mano"}
                    >
                      {h.verificado ? <Check className="h-3 w-3" /> : "verificar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => patch(`/api/expediente/hechos/${h.id}`, { accion: "cerrar" })}
                      className="rounded-control border border-cos-line px-2 py-0.5 text-[11.5px] text-cos-ink-faint hover:border-cos-red-ink hover:text-cos-red-ink"
                      title="Dejó de ser cierto (no se borra: se le pone fecha de fin)"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <form
          className="flex flex-wrap items-end gap-2 border-t border-cos-line-soft px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nuevoHecho.clave.trim() || !nuevoHecho.valor.trim()) return;
            void enviar({ kind: "hecho", ...nuevoHecho }).then(() => setNuevoHecho({ clave: "", valor: "" }));
          }}
        >
          <label className="min-w-[10rem] flex-1">
            <span className={EYEBROW}>Clave</span>
            <input
              className={INPUT}
              placeholder="terminal.afiliacion"
              value={nuevoHecho.clave}
              onChange={(e) => setNuevoHecho((s) => ({ ...s, clave: e.target.value }))}
            />
          </label>
          <label className="min-w-[12rem] flex-[2]">
            <span className={EYEBROW}>Valor</span>
            <input
              className={INPUT}
              placeholder="Banorte, afiliación 7788"
              value={nuevoHecho.valor}
              onChange={(e) => setNuevoHecho((s) => ({ ...s, valor: e.target.value }))}
            />
          </label>
          <button type="submit" className={BTN} disabled={guardando}>
            <Plus className="h-3.5 w-3.5" /> Registrar
          </button>
        </form>
      </Card>

      {/* ── Compromisos abiertos ───────────────────────────────────────── */}
      {pendientes.length > 0 && (
        <Card>
          <p className={`px-4 py-2.5 ${EYEBROW}`}>Compromisos abiertos</p>
          <ul className="border-t border-cos-line-soft">
            {pendientes.map((n) => (
              <li key={n.id} className="border-b border-cos-line-soft px-4 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-semibold text-cos-ink">{n.titulo}</span>
                  <span className="text-[11.5px] text-cos-ink-faint">
                    {TITULO_TEMA[n.tema] ?? n.tema} · {fecha(n.createdAt)} · {n.autor}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const porque = window.prompt("¿Qué lo resolvió? Queda escrito y enlazado.");
                      if (porque?.trim()) void patch(`/api/expediente/notas/${n.id}`, { accion: "resolver", porque });
                    }}
                    className="ml-auto rounded-control border border-cos-line px-2 py-0.5 text-[11.5px] font-semibold text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink"
                  >
                    cerrar
                  </button>
                </div>
                <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">{n.cuerpo}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── Bitácora ───────────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <p className={EYEBROW}>Bitácora</p>
          <select
            className="rounded-control border border-cos-line bg-cos-card px-2 py-1 text-[12.5px] text-cos-ink"
            value={tema}
            onChange={(e) => setTema(e.target.value as TemaExpediente | "")}
          >
            <option value="">Todos los temas</option>
            {TEMAS.map((t) => (
              <option key={t} value={t}>
                {TITULO_TEMA[t]}
              </option>
            ))}
          </select>
        </div>

        {!cargando && notas.length === 0 && (
          <p className="border-t border-cos-line-soft px-4 py-3 text-[12.5px] text-cos-ink-faint">
            Sin notas todavía.
          </p>
        )}

        <ul className="border-t border-cos-line-soft">
          {notas.map((n) => (
            <li key={n.id} className="border-b border-cos-line-soft px-4 py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-semibold text-cos-ink">{n.titulo}</span>
                <span className="text-[11.5px] text-cos-ink-faint">
                  {TITULO_TIPO[n.tipo] ?? n.tipo} · {TITULO_TEMA[n.tema] ?? n.tema} · {fecha(n.createdAt)} · {n.autor}
                </span>
                {n.tipo === "pendiente" && n.estado === "resuelta" && (
                  <button
                    type="button"
                    onClick={() => patch(`/api/expediente/notas/${n.id}`, { accion: "reabrir" })}
                    className="ml-auto inline-flex items-center gap-1 rounded-control border border-cos-line px-2 py-0.5 text-[11.5px] text-cos-ink-faint hover:border-cos-brand hover:text-cos-brand-ink"
                  >
                    <RotateCcw className="h-3 w-3" /> reabrir
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-cos-ink-soft">{n.cuerpo}</p>
            </li>
          ))}
        </ul>

        <form
          className="space-y-2 border-t border-cos-line-soft px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nuevaNota.titulo.trim() || !nuevaNota.cuerpo.trim()) return;
            void enviar(nuevaNota).then(() => setNuevaNota((s) => ({ ...s, titulo: "", cuerpo: "" })));
          }}
        >
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-control border border-cos-line bg-cos-card px-2 py-1.5 text-[12.5px] text-cos-ink"
              value={nuevaNota.tipo}
              onChange={(e) => setNuevaNota((s) => ({ ...s, tipo: e.target.value as TipoNota }))}
            >
              <option value="observacion">Observación</option>
              <option value="decision">Decisión</option>
              <option value="pendiente">Pendiente</option>
            </select>
            <select
              className="rounded-control border border-cos-line bg-cos-card px-2 py-1.5 text-[12.5px] text-cos-ink"
              value={nuevaNota.tema}
              onChange={(e) => setNuevaNota((s) => ({ ...s, tema: e.target.value as TemaExpediente }))}
            >
              {TEMAS.map((t) => (
                <option key={t} value={t}>
                  {TITULO_TEMA[t]}
                </option>
              ))}
            </select>
            <input
              className={`${INPUT} min-w-[12rem] flex-1`}
              placeholder="Título: qué pasó, en una línea"
              value={nuevaNota.titulo}
              onChange={(e) => setNuevaNota((s) => ({ ...s, titulo: e.target.value }))}
            />
          </div>
          <textarea
            className={`${INPUT} min-h-[4.5rem]`}
            placeholder="Qué pasó y por qué importa. Si es un pendiente, di qué falta y de quién."
            value={nuevaNota.cuerpo}
            onChange={(e) => setNuevaNota((s) => ({ ...s, cuerpo: e.target.value }))}
          />
          <button type="submit" className={BTN} disabled={guardando}>
            <Plus className="h-3.5 w-3.5" /> Anotar
          </button>
        </form>
      </Card>
    </div>
  );
}
