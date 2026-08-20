"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo y decisiones de mapeo (brief UX, módulo P1-4): «¿a qué cuenta MÍA
// va cada cosa que el motor postea?». La cola de ambigüedades — códigos del
// motor con varias candidatas, que hasta hoy se resolvían por script — como
// decisiones de un clic que escriben PostingCuentaOverride. El override
// aplica en el SIGUIENTE posteo; la UI lo dice y liga al Cierre.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Loader2, Trash2, X } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { StatTile, StatStrip } from "@/components/ui";
import { cn } from "@/lib/utils";

interface CuentaPropia {
  id: string;
  codigo: string;
  nombre: string;
  nivel: number;
  tipo: string | null;
  codAgrup: string | null;
}
interface Cobertura {
  codigoMotor: string;
  estado: "unica" | "override" | "ambigua" | "sin_candidata";
  candidatas: number;
  cuenta?: { cuentaSAT: string; nombre: string };
  nombreAgrupador: string | null;
}

const CHIP_ESTADO: Record<Cobertura["estado"], { t: string; cls: string }> = {
  unica: { t: "Única", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  override: { t: "Decidida", cls: "bg-cos-brand-tint text-cos-brand-ink" },
  ambigua: { t: "Ambigua", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  sin_candidata: { t: "Sin candidata", cls: "bg-cos-red-tint text-cos-red-ink" },
};

export default function CatalogoPage() {
  const { activeCompany } = useCompany();
  const [cobertura, setCobertura] = useState<Cobertura[] | null>(null);
  const [cuentas, setCuentas] = useState<CuentaPropia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<string | null>(null); // codigoMotor expandido
  const [eleccion, setEleccion] = useState<string | null>(null); // chartAccountId
  const [busqueda, setBusqueda] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [filtroCat, setFiltroCat] = useState<"todos" | "sin_agrupador" | "sin_nombre">("todos");
  const [aviso, setAviso] = useState<React.ReactNode>("");
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    if (!activeCompany) return;
    setCargando(true);
    try {
      const res = await fetch(`/api/contabilidad/posting-overrides?companyId=${activeCompany.id}`);
      const d = await res.json();
      if (res.ok && Array.isArray(d?.cobertura)) {
        setCobertura(d.cobertura);
        setCuentas(d.cuentas ?? []);
      } else {
        setCobertura(null);
      }
    } catch {
      setCobertura(null);
    } finally {
      setCargando(false);
    }
  }, [activeCompany]);

  useEffect(() => { cargar(); }, [cargar]);

  const pendientes = useMemo(
    () => (cobertura ?? []).filter((c) => c.estado === "ambigua" || c.estado === "sin_candidata"),
    [cobertura]
  );
  const overrides = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "override"), [cobertura]);
  const unicas = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "unica"), [cobertura]);

  const candidatasDe = useCallback(
    (codigo: string) => cuentas.filter((c) => c.codAgrup === codigo),
    [cuentas]
  );

  const resultadosBusqueda = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return [];
    return cuentas
      .filter((c) => c.nivel >= 3)
      .filter((c) => c.codigo.toLowerCase().startsWith(q) || c.nombre.toLowerCase().includes(q))
      .slice(0, 8);
  }, [busqueda, cuentas]);

  const catalogoVisible = useMemo(() => {
    if (filtroCat === "sin_agrupador") return cuentas.filter((c) => c.nivel >= 3 && !c.codAgrup);
    if (filtroCat === "sin_nombre") return cuentas.filter((c) => !c.nombre?.trim());
    return cuentas;
  }, [cuentas, filtroCat]);

  function expandir(codigo: string) {
    setAbierto((prev) => (prev === codigo ? null : codigo));
    setEleccion(null);
    setBusqueda("");
  }

  async function guardar(codigoMotor: string) {
    if (!activeCompany || !eleccion) return;
    setGuardando(true); setError(""); setAviso("");
    try {
      const res = await fetch("/api/contabilidad/posting-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, codigoMotor, chartAccountId: eleccion }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo guardar la decisión");
      setAviso(
        <>
          Decisión guardada: <span className="font-mono">{codigoMotor}</span> →{" "}
          <span className="font-mono">{d.cuenta.codigo}</span> {d.cuenta.nombre}. Aplica en el
          siguiente posteo —{" "}
          <Link href="/contabilidad/cierre" className="font-medium underline">ir al Cierre</Link>.
        </>
      );
      setAbierto(null);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la decisión");
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(codigoMotor: string) {
    if (!activeCompany) return;
    if (!confirm(`¿Quitar la decisión de ${codigoMotor}? El código vuelve a resolverse solo (o a quedar ambiguo).`)) return;
    setGuardando(true); setError(""); setAviso("");
    try {
      const res = await fetch(
        `/api/contabilidad/posting-overrides?companyId=${activeCompany.id}&codigoMotor=${encodeURIComponent(codigoMotor)}`,
        { method: "DELETE" }
      );
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo quitar el override");
      setAviso(`Override de ${codigoMotor} eliminado. Aplica en el siguiente posteo.`);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo quitar el override");
    } finally {
      setGuardando(false);
    }
  }

  if (!activeCompany) return null;

  const th = "px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-cos-ink-faint text-left";

  return (
    <div>
      <FlowPageHeader
        title="Catálogo y mapeo"
        subtitle="A qué cuenta tuya va cada cosa que el motor postea"
        context={
          cobertura
            ? `${cobertura.length} códigos del motor · ${pendientes.length} por decidir · ${cuentas.length} cuentas propias`
            : undefined
        }
      />

      {aviso && (
        <div className="mb-4 flex items-start gap-2 rounded-card bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink">
          <Check className="mt-0.5 h-4 w-4 shrink-0" /> <span className="flex-1">{aviso}</span>
          <button onClick={() => setAviso("")} aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Cerrar error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {cargando ? (
        <div className="flex items-center gap-2 rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> Evaluando la cobertura del plan propio…
        </div>
      ) : !cobertura ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
          No se pudo evaluar la cobertura. Revisa que la empresa tenga catálogo.
        </div>
      ) : (
        <>
          <StatStrip>
            <StatTile
              label="Cubiertos"
              tone="jade"
              value={unicas.length + overrides.length}
              sub={`de ${cobertura.length} códigos del motor`}
            />
            <StatTile
              label="Ambiguos"
              tone={pendientes.some((p) => p.estado === "ambigua") ? "amber" : "jade"}
              value={pendientes.filter((p) => p.estado === "ambigua").length}
              sub="varias candidatas — decide una"
            />
            <StatTile
              label="Sin candidata"
              tone={pendientes.some((p) => p.estado === "sin_candidata") ? "red" : "jade"}
              value={pendientes.filter((p) => p.estado === "sin_candidata").length}
              sub="ninguna cuenta con ese agrupador"
            />
            <StatTile label="Decisiones tomadas" tone="brand" value={overrides.length} sub="overrides del contador" />
          </StatStrip>

          {/* ── La cola de ambigüedades ── */}
          <section className="mb-5 rounded-card border border-cos-line bg-cos-card">
            <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
              Cola de decisiones · {pendientes.length}
            </h2>
            {pendientes.length === 0 ? (
              <p className="px-5 py-5 text-sm text-cos-ink-soft">
                Sin pendientes: cada código del motor resuelve a una cuenta tuya, solo o por tu decisión.
              </p>
            ) : (
              <ul>
                {pendientes.map((p) => {
                  const abiertoAqui = abierto === p.codigoMotor;
                  const candidatas = candidatasDe(p.codigoMotor);
                  const opciones = abiertoAqui
                    ? busqueda.trim()
                      ? resultadosBusqueda
                      : candidatas
                    : [];
                  return (
                    <li key={p.codigoMotor} className="border-b border-cos-line-soft last:border-b-0">
                      <button
                        onClick={() => expandir(p.codigoMotor)}
                        className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-cos-paper"
                      >
                        {abiertoAqui ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-cos-ink-faint" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-cos-ink-faint" />
                        )}
                        <span className="w-20 shrink-0 font-mono text-[13px] text-cos-ink">{p.codigoMotor}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-cos-ink-soft">
                          {p.nombreAgrupador ?? "(agrupador sin nombre oficial)"}
                        </span>
                        {p.estado === "ambigua" && (
                          <span className="font-mono text-[11px] text-cos-ink-faint">{p.candidatas} candidatas</span>
                        )}
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", CHIP_ESTADO[p.estado].cls)}>
                          {CHIP_ESTADO[p.estado].t}
                        </span>
                      </button>

                      {abiertoAqui && (
                        <div className="border-t border-cos-line-soft bg-cos-paper px-5 py-3">
                          {p.estado === "sin_candidata" && !busqueda.trim() && (
                            <p className="mb-2 text-[12px] text-cos-ink-soft">
                              Ninguna cuenta de tu catálogo declara el agrupador{" "}
                              <span className="font-mono">{p.codigoMotor}</span>. Busca la cuenta a la
                              que debe ir y quedará como tu decisión.
                            </p>
                          )}
                          <input
                            value={busqueda}
                            onChange={(e) => { setBusqueda(e.target.value); setEleccion(null); }}
                            placeholder={
                              p.estado === "ambigua"
                                ? "…o busca otra cuenta por código o nombre"
                                : "busca por código o nombre"
                            }
                            className="mb-2 w-full max-w-sm rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] placeholder:text-cos-ink-faint"
                          />
                          <ul className="max-h-56 overflow-y-auto">
                            {opciones.map((c) => (
                              <li key={c.id}>
                                <label
                                  className={cn(
                                    "flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5",
                                    eleccion === c.id ? "bg-cos-brand-tint" : "hover:bg-cos-card"
                                  )}
                                >
                                  <input
                                    type="radio"
                                    name={`cand-${p.codigoMotor}`}
                                    checked={eleccion === c.id}
                                    onChange={() => setEleccion(c.id)}
                                    className="translate-y-0.5 accent-[--brand]"
                                  />
                                  <span className="w-20 shrink-0 font-mono text-[13px]">{c.codigo}</span>
                                  <span className="min-w-0 flex-1 truncate text-[13px] text-cos-ink">{c.nombre}</span>
                                  {c.codAgrup && (
                                    <span className="font-mono text-[11px] text-cos-ink-faint">agrup {c.codAgrup}</span>
                                  )}
                                </label>
                              </li>
                            ))}
                            {opciones.length === 0 && (
                              <li className="px-2 py-1.5 text-[12px] text-cos-ink-faint">Sin resultados.</li>
                            )}
                          </ul>
                          <button
                            onClick={() => guardar(p.codigoMotor)}
                            disabled={!eleccion || guardando}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                          >
                            {guardando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Guardar decisión
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Decisiones tomadas ── */}
          {overrides.length > 0 && (
            <section className="mb-5 rounded-card border border-cos-line bg-cos-card">
              <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
                Decisiones tomadas · {overrides.length}
              </h2>
              <ul>
                {overrides.map((o) => (
                  <li key={o.codigoMotor} className="flex items-center gap-3 border-b border-cos-line-soft px-5 py-2.5 last:border-b-0">
                    <span className="w-20 shrink-0 font-mono text-[13px]">{o.codigoMotor}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-cos-ink-soft">
                      {o.nombreAgrupador ?? ""} →{" "}
                      <span className="font-mono text-cos-ink">{o.cuenta?.cuentaSAT}</span>{" "}
                      <span className="text-cos-ink">{o.cuenta?.nombre}</span>
                    </span>
                    <button
                      onClick={() => quitar(o.codigoMotor)}
                      disabled={guardando}
                      aria-label={`Quitar override de ${o.codigoMotor}`}
                      className="rounded p-1 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-red-ink"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Resueltos solos ── */}
          <details className="mb-5 rounded-card border border-cos-line bg-cos-card">
            <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-cos-ink [&::-webkit-details-marker]:hidden">
              Resueltos sin ayuda (agrupador único) · {unicas.length}
            </summary>
            <ul className="border-t border-cos-line">
              {unicas.map((u) => (
                <li key={u.codigoMotor} className="flex items-center gap-3 border-b border-cos-line-soft px-5 py-2 last:border-b-0 text-[13px]">
                  <span className="w-20 shrink-0 font-mono">{u.codigoMotor}</span>
                  <span className="min-w-0 flex-1 truncate text-cos-ink-soft">
                    {u.nombreAgrupador ?? ""} → <span className="font-mono text-cos-ink">{u.cuenta?.cuentaSAT}</span>{" "}
                    <span className="text-cos-ink">{u.cuenta?.nombre}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>

          {/* ── Catálogo navegable ── */}
          <section className="rounded-card border border-cos-line bg-cos-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-cos-ink">Catálogo propio · {catalogoVisible.length}</h2>
              <div className="flex gap-1.5">
                {([
                  ["todos", "Todas"],
                  ["sin_agrupador", "Sin agrupador"],
                  ["sin_nombre", "Sin nombre"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setFiltroCat(id)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12px] font-medium",
                      filtroCat === id
                        ? "bg-cos-brand-tint text-cos-brand-ink"
                        : "text-cos-ink-soft hover:bg-cos-paper"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[440px] overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-cos-card">
                  <tr className="border-b border-cos-line">
                    <th className={cn(th, "w-28")}>Cuenta</th>
                    <th className={th}>Nombre</th>
                    <th className={cn(th, "w-24")}>Tipo</th>
                    <th className={cn(th, "w-28")}>Agrupador</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogoVisible.map((c) => (
                    <tr key={c.id} className="h-[34px] border-b border-cos-line-soft hover:bg-cos-paper">
                      <td className={cn("px-3 py-0 font-mono", c.nivel === 1 && "font-semibold", c.nivel >= 3 && "pl-6")}>
                        {c.codigo}
                      </td>
                      <td className={cn("max-w-[280px] truncate px-3 py-0", c.nivel === 1 && "font-semibold uppercase")}>
                        {c.nombre?.trim() || (
                          <span className="rounded-full bg-cos-red-tint px-2 py-0.5 text-[11px] font-semibold text-cos-red-ink">
                            sin nombre
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-0 text-[12px] text-cos-ink-faint">{c.tipo ?? ""}</td>
                      <td className="px-3 py-0 font-mono text-[12px]">
                        {c.codAgrup ?? (
                          c.nivel >= 3 ? (
                            <span className="rounded-full bg-cos-amber-tint px-2 py-0.5 font-sans text-[11px] font-semibold text-cos-amber-ink">
                              sin agrupador
                            </span>
                          ) : ""
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
