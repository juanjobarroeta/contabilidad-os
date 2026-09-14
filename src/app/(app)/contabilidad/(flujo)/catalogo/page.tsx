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
  /** Cuentas que cuelgan de ésta. > 0 = acumulativa: no recibe pólizas. */
  subcuentas: number;
}
interface Cobertura {
  codigoMotor: string;
  estado: "unica" | "override" | "ambigua" | "sin_candidata" | "por_dimension" | "por_modulo";
  candidatas: number;
  acumulativas?: number;
  cuenta?: { cuentaSAT: string; nombre: string };
  nombreAgrupador: string | null;
  dimension: "FIJA" | "CONTRAPARTE" | "EJERCICIO";
  padron?: "BANCO" | "CLIENTE" | "PROVEEDOR" | "RELACIONADA";
  porque: string;
}

interface CuentaMini { id: string; codigo: string; nombre: string }

/** Un renglón del mapa del hospital: GET /api/hospital/contabilidad/mapa. */
interface RenglonHospital {
  clave: string;
  descripcion: string;
  cuentaSAT: string;
  origen: "DEFAULT" | "CONFIG" | "OVERRIDE";
  cuenta: CuentaMini | null;
  candidatas: CuentaMini[];
  sugerencia: { cuenta: CuentaMini; confianza: "EXACTA" | "PARECIDA"; porque: string; alternativas: CuentaMini[] } | null;
}

interface Pareja {
  chartAccountId: string;
  codigo: string;
  nombreCuenta: string;
  customerId: string;
  customerNombre: string;
  customerRfc: string;
  confianza: "EXACTA" | "PARECIDA";
}
interface Auxiliares {
  codigoMotor: string;
  nombreAgrupador: string | null;
  pares: Pareja[];
  sinPareja: { chartAccountId: string; codigo: string; nombreCuenta: string; motivo: "sin_candidata" | "varias_candidatas" }[];
  yaLigados: number;
}

const CHIP_ESTADO: Record<Cobertura["estado"], { t: string; cls: string }> = {
  unica: { t: "Única", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  override: { t: "Decidida", cls: "bg-cos-brand-tint text-cos-brand-ink" },
  ambigua: { t: "Ambigua", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  sin_candidata: { t: "Sin candidata", cls: "bg-cos-red-tint text-cos-red-ink" },
  // No es un pendiente: es el catálogo bien armado, con un auxiliar por
  // contraparte. Se enseña aparte y sin pedir nada.
  por_dimension: { t: "Por contraparte", cls: "bg-cos-brand-tint text-cos-brand-ink" },
  // Tampoco: el módulo ya decide ese código por clave (un hospital parte su
  // 401.01 por servicio). La decisión se toma abajo, no aquí.
  por_modulo: { t: "Por módulo", cls: "bg-cos-brand-tint text-cos-brand-ink" },
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
  const [auxiliares, setAuxiliares] = useState<Auxiliares[]>([]);
  // «No es» sólo esconde la propuesta en esta sesión: no hay dónde guardar un
  // rechazo, y volver a verla la próxima vez es más barato que un enlace malo.
  const [descartadas, setDescartadas] = useState<Set<string>>(new Set());
  const [enlazando, setEnlazando] = useState<string | null>(null);
  const [hospital, setHospital] = useState<RenglonHospital[] | null>(null);

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

  const cargarAuxiliares = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/contabilidad/auxiliares?companyId=${activeCompany.id}`);
      const d = await res.json();
      setAuxiliares(res.ok && Array.isArray(d?.codigos) ? d.codigos : []);
    } catch {
      setAuxiliares([]);
    }
  }, [activeCompany]);

  // El mapa del hospital sólo existe con el módulo contratado: un 403 aquí no
  // es un error, es una empresa que no es hospital.
  const cargarHospital = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/hospital/contabilidad/mapa?companyId=${activeCompany.id}`);
      const d = await res.json();
      setHospital(res.ok && Array.isArray(d?.claves) ? d.claves : null);
    } catch {
      setHospital(null);
    }
  }, [activeCompany]);

  useEffect(() => { cargar(); cargarAuxiliares(); cargarHospital(); }, [cargar, cargarAuxiliares, cargarHospital]);

  // Pendientes = lo que una persona SÍ puede contestar. Un código que se
  // resuelve por contraparte no entra: pedir que se elija uno de 31 auxiliares
  // de proveedor manda el saldo de los 31 a la que se haya clicado.
  const pendientes = useMemo(
    () => (cobertura ?? []).filter((c) => c.estado === "ambigua" || c.estado === "sin_candidata"),
    [cobertura]
  );
  const porDimension = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "por_dimension"), [cobertura]);
  const porModulo = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "por_modulo"), [cobertura]);
  // Las claves del hospital que piden decisión: varias candidatas, o ya decidida
  // (se enseña para poder cambiarla). Las que resuelven solas no estorban.
  const filasHospital = useMemo(
    () => (hospital ?? []).filter((r) => r.candidatas.length > 1 || r.origen === "OVERRIDE"),
    [hospital]
  );
  const sugerenciasExactas = useMemo(
    () => filasHospital.filter((r) => r.sugerencia?.confianza === "EXACTA").length,
    [filasHospital]
  );
  const overrides = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "override"), [cobertura]);
  const unicas = useMemo(() => (cobertura ?? []).filter((c) => c.estado === "unica"), [cobertura]);
  // ¿La empresa declara agrupadores en cuentas propias? Sin ninguno, el motor
  // postea directo al catálogo SAT y la cola de mapeo no aplica. Las subcuentas
  // de banco (102.01.NN) no cuentan: las crea el propio motor con su codAgrup
  // — no son una decisión del contador.
  const planPropio = useMemo(
    () => cuentas.some((c) => c.codAgrup && !c.codigo.startsWith("102.01.")),
    [cuentas]
  );

  // Las acumulativas (con subcuentas) van al final y apagadas: la decisión es
  // entre las cuentas de detalle, que es donde caen las pólizas.
  const candidatasDe = useCallback(
    (codigo: string) =>
      cuentas
        .filter((c) => c.codAgrup === codigo)
        .sort((a, b) => (a.subcuentas > 0 ? 1 : 0) - (b.subcuentas > 0 ? 1 : 0)),
    [cuentas]
  );

  const resultadosBusqueda = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return [];
    return cuentas
      .filter((c) => c.subcuentas === 0)
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
          <span className="font-mono">{d.cuenta.codigo}</span> {d.cuenta.nombre}. Aplica en la
          siguiente contabilización —{" "}
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

  async function enlazar(par: Pareja) {
    if (!activeCompany) return;
    setEnlazando(par.chartAccountId); setError("");
    try {
      const res = await fetch("/api/contabilidad/auxiliares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, parejas: [{ chartAccountId: par.chartAccountId, customerId: par.customerId }] }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo enlazar");
      setAviso(
        <>
          <span className="font-mono">{par.codigo}</span> {par.nombreCuenta} → {par.customerNombre}. Aplica en la siguiente
          contabilización.
        </>
      );
      await cargarAuxiliares();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enlazar");
    } finally {
      setEnlazando(null);
    }
  }

  async function aplicarExactas(codigoMotor: string) {
    if (!activeCompany) return;
    setEnlazando(`exactas-${codigoMotor}`); setError("");
    try {
      const res = await fetch("/api/contabilidad/auxiliares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, codigoMotor, modo: "exactas" }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudieron aplicar las exactas");
      setAviso(`${d.aplicadas ?? 0} auxiliares de ${codigoMotor} enlazados por nombre idéntico. Aplica en la siguiente contabilización.`);
      await cargarAuxiliares();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron aplicar las exactas");
    } finally {
      setEnlazando(null);
    }
  }

  /** Guarda la cuenta de una clave del hospital (o aplica de una las propuestas seguras). */
  async function decidirHospital(cuerpo: Record<string, unknown>, quien: string, mensaje: (d: { aplicadas?: string[] }) => string) {
    if (!activeCompany) return;
    setEnlazando(quien); setError(""); setAviso("");
    try {
      const res = await fetch("/api/hospital/contabilidad/mapa", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, ...cuerpo }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo guardar la decisión del hospital");
      setHospital(Array.isArray(d?.claves) ? d.claves : null);
      setAviso(
        <>
          {mensaje(d ?? {})} Aplica en la siguiente contabilización —{" "}
          <Link href="/contabilidad/cierre" className="font-medium underline">ir al Cierre</Link>.
        </>
      );
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la decisión del hospital");
    } finally {
      setEnlazando(null);
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
      setAviso(`Override de ${codigoMotor} eliminado. Aplica en la siguiente contabilización.`);
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
        subtitle="A qué cuenta tuya va cada cosa que el motor contabiliza"
        context={
          cobertura
            ? planPropio
              ? `${cobertura.length} códigos del motor · ${pendientes.length} por decidir · ${cuentas.length} cuentas propias`
              : `${cobertura.length} códigos del motor · catálogo SAT, nada que mapear · ${cuentas.length} cuentas propias`
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
          {/* Sin plan propio no hay nada que mapear: el motor postea directo a
              las cuentas del catálogo SAT. Pintar «0 cubiertos · 39 sin
              candidata» en rojo aquí acusaba un problema inexistente. */}
          {!planPropio ? (
            <div className="mb-5 flex items-start gap-2 rounded-card bg-cos-jade-tint px-4 py-3.5 text-sm text-cos-jade-ink">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Tu catálogo es el del SAT (código agrupador): cada código del motor postea
                directo a su cuenta y no hay nada que mapear. Esta cola de decisiones se usa
                cuando importas un catálogo propio y declaras el agrupador de cada cuenta.
              </span>
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
            <StatTile
              label="Por contraparte"
              tone="brand"
              value={porDimension.length}
              sub="se resuelven solos — no se eligen"
            />
            <StatTile label="Decisiones tomadas" tone="brand" value={overrides.length} sub="overrides del contador" />
          </StatStrip>

          {/* ── Hospital: la decisión es por CLAVE, y el sistema la propone ────── */}
          {filasHospital.length > 0 && (
            <section className="mb-5 rounded-card border border-cos-line bg-cos-card">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-cos-line px-5 py-3.5">
                <h2 className="text-sm font-semibold text-cos-ink">Cuentas del hospital · {filasHospital.length}</h2>
                {sugerenciasExactas > 0 && (
                  <button
                    onClick={() =>
                      decidirHospital(
                        { aplicarSugerencias: true },
                        "sugerencias",
                        (d) => `${d.aplicadas?.length ?? 0} cuentas del hospital quedaron decididas por nombre.`
                      )
                    }
                    disabled={enlazando !== null}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[12px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                  >
                    {enlazando === "sugerencias" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Aplicar {sugerenciasExactas} propuestas
                  </button>
                )}
              </div>
              <p className="px-5 pt-3 text-xs text-cos-ink-soft">
                Tu catálogo parte los ingresos, el costo y el inventario por SERVICIO —28 cuentas con el agrupador
                401.01, una por servicio—, así que «¿cuál es LA cuenta de ventas?» no tiene respuesta. El módulo sí sabe
                de qué servicio es cada asiento, y aquí se decide por eso: una cuenta por clave. Lo que el nombre dice sin
                lugar a dudas se aplica en bloque; lo que es criterio —laboratorio o imagen para los estudios— lo eliges tú.
              </p>
              <ul>
                {filasHospital.map((r) => (
                  <li key={r.clave} className="border-t border-cos-line-soft px-5 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
                      <span className="text-cos-ink">{r.descripcion}</span>
                      <span className="font-mono text-[11px] text-cos-ink-faint">
                        agrup {r.cuentaSAT} · {r.candidatas.length} candidatas
                      </span>
                      {r.origen === "OVERRIDE" && r.cuenta && (
                        <span className="ml-auto inline-flex items-center gap-1 rounded-cos-chip bg-cos-jade-tint px-1.5 py-0.5 text-[11px] text-cos-jade-ink">
                          <Check className="h-3 w-3" />
                          {r.cuenta.codigo} {r.cuenta.nombre}
                        </span>
                      )}
                    </div>
                    {r.sugerencia && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-cos-paper px-3 py-1.5 text-[12.5px]">
                        <span
                          className={cn(
                            "rounded-cos-chip px-1.5 py-0.5 text-[11px]",
                            r.sugerencia.confianza === "EXACTA" ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-amber-tint text-cos-amber-ink"
                          )}
                        >
                          {r.sugerencia.confianza === "EXACTA" ? "Propuesta" : "Revísala"}
                        </span>
                        <span className="font-mono text-cos-ink">{r.sugerencia.cuenta.codigo}</span>
                        <span className="min-w-0 truncate text-cos-ink">{r.sugerencia.cuenta.nombre}</span>
                        <span className="min-w-0 text-cos-ink-faint">{r.sugerencia.porque}</span>
                        <button
                          onClick={() =>
                            decidirHospital(
                              { cuentas: { [r.clave]: { cuentaSAT: r.cuentaSAT, subcuenta: r.sugerencia!.cuenta.codigo } } },
                              r.clave,
                              () => `${r.descripcion} → ${r.sugerencia!.cuenta.codigo} ${r.sugerencia!.cuenta.nombre}.`
                            )
                          }
                          disabled={enlazando !== null}
                          className="ml-auto shrink-0 rounded-control border border-cos-line bg-cos-card px-2.5 py-1 text-[12px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                        >
                          Usar ésta
                        </button>
                      </div>
                    )}
                    {/* Elegir a mano, pero sólo entre las candidatas del agrupador: buscar
                        en 2 340 cuentas es de donde salen los enlaces malos. */}
                    <select
                      value=""
                      disabled={enlazando !== null}
                      onChange={(e) => {
                        const cuenta = r.candidatas.find((c) => c.id === e.target.value);
                        if (!cuenta) return;
                        decidirHospital(
                          { cuentas: { [r.clave]: { cuentaSAT: r.cuentaSAT, subcuenta: cuenta.codigo } } },
                          r.clave,
                          () => `${r.descripcion} → ${cuenta.codigo} ${cuenta.nombre}.`
                        );
                      }}
                      className="mt-2 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12.5px] text-cos-ink"
                    >
                      <option value="">
                        {r.origen === "OVERRIDE" ? "Cambiar a otra cuenta…" : `Elegir entre las ${r.candidatas.length} cuentas con agrupador ${r.cuentaSAT}…`}
                      </option>
                      {r.candidatas.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.codigo} — {c.nombre}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {porDimension.length > 0 && (
            <section className="rounded-cos border border-cos-line bg-cos-panel p-4">
              <h2 className="text-sm font-semibold text-cos-ink">Se resuelven por contraparte, no aquí</h2>
              <p className="mt-1 text-xs text-cos-ink-soft">
                Estos códigos tienen varias cuentas porque su catálogo lleva un auxiliar por contraparte —un
                proveedor, un cliente, un banco por cuenta—. Eso no es una ambigüedad que resolver: elegir una
                mandaría el saldo de todas a la que se elija. La cuenta la decide el RFC de cada comprobante.
              </p>
              <ul className="mt-3 space-y-2">
                {porDimension.map((c) => (
                  <li key={c.codigoMotor} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                    <span className="font-mono font-medium text-cos-ink">{c.codigoMotor}</span>
                    <span className="text-cos-ink">{c.nombreAgrupador ?? ""}</span>
                    <span className="rounded-cos-chip bg-cos-brand-tint px-1.5 py-0.5 text-cos-brand-ink">
                      {c.candidatas} auxiliares
                    </span>
                    <span className="text-cos-ink-soft">{c.porque}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {porModulo.length > 0 && (
            <section className="mt-5 rounded-cos border border-cos-line bg-cos-panel p-4">
              <h2 className="text-sm font-semibold text-cos-ink">Se deciden por clave del módulo, no por código</h2>
              <p className="mt-1 text-xs text-cos-ink-soft">
                El mismo código es varias cuentas tuyas según el servicio que lo origina: un cargo de quirófano y uno de
                urgencias son los dos 401.01 y van a cuentas distintas. Por eso no se decide aquí, sino arriba, una vez
                por clave del hospital.
              </p>
              <ul className="mt-3 space-y-2">
                {porModulo.map((c) => (
                  <li key={c.codigoMotor} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                    <span className="font-mono font-medium text-cos-ink">{c.codigoMotor}</span>
                    <span className="text-cos-ink">{c.nombreAgrupador ?? ""}</span>
                    <span className="rounded-cos-chip bg-cos-brand-tint px-1.5 py-0.5 text-cos-brand-ink">{c.candidatas} candidatas</span>
                    <span className="text-cos-ink-soft">{c.porque}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Auxiliares por contraparte: propuestas que confirma una persona ── */}
          {auxiliares.some((a) => a.pares.length > 0) && (
            <section className="mb-5 rounded-card border border-cos-line bg-cos-card">
              <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
                Auxiliares por confirmar ·{" "}
                {auxiliares.reduce((n, a) => n + a.pares.filter((x) => !descartadas.has(x.chartAccountId)).length, 0)}
              </h2>
              <p className="px-5 pt-3 text-xs text-cos-ink-soft">
                Tu catálogo nombra a la contraparte en cada auxiliar («201001010 Union garza…») y el padrón la tiene con su
                razón social. Los nombres idénticos se enlazan solos; los parecidos —truncados, con una errata— los confirma
                alguien que los mire: un enlace malo cuadra igual, con el saldo en el renglón de otro.
              </p>
              <ul>
                {auxiliares
                  .filter((a) => a.pares.length > 0)
                  .map((a) => {
                    const exactas = a.pares.filter((x) => x.confianza === "EXACTA");
                    const parecidas = a.pares.filter((x) => x.confianza === "PARECIDA" && !descartadas.has(x.chartAccountId));
                    return (
                      <li key={a.codigoMotor} className="border-t border-cos-line-soft px-5 py-3">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
                          <span className="font-mono text-cos-ink">{a.codigoMotor}</span>
                          <span className="text-cos-ink-soft">{a.nombreAgrupador ?? ""}</span>
                          <span className="font-mono text-[11px] text-cos-ink-faint">
                            {a.yaLigados} enlazados · {parecidas.length} por confirmar · {a.sinPareja.length} sin pareja
                          </span>
                          {exactas.length > 0 && (
                            <button
                              onClick={() => aplicarExactas(a.codigoMotor)}
                              disabled={enlazando !== null}
                              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-2.5 py-1 text-[12px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                            >
                              {enlazando === `exactas-${a.codigoMotor}` && <Loader2 className="h-3 w-3 animate-spin" />}
                              Enlazar {exactas.length} idénticos
                            </button>
                          )}
                        </div>
                        {parecidas.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {parecidas.map((x) => (
                              <li key={x.chartAccountId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-cos-paper px-3 py-1.5 text-[12.5px]">
                                <span className="font-mono text-cos-ink">{x.codigo}</span>
                                <span className="min-w-0 truncate text-cos-ink">{x.nombreCuenta}</span>
                                <span className="text-cos-ink-faint">→</span>
                                <span className="min-w-0 truncate text-cos-ink">{x.customerNombre}</span>
                                <span className="font-mono text-[11px] text-cos-ink-faint">{x.customerRfc}</span>
                                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <button
                                    onClick={() => enlazar(x)}
                                    disabled={enlazando !== null}
                                    className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-2.5 py-1 text-[12px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                                  >
                                    {enlazando === x.chartAccountId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                    Enlazar
                                  </button>
                                  <button
                                    onClick={() => setDescartadas((prev) => new Set(prev).add(x.chartAccountId))}
                                    disabled={enlazando !== null}
                                    className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2.5 py-1 text-[12px] text-cos-ink-soft hover:bg-cos-card disabled:opacity-50"
                                  >
                                    <X className="h-3 w-3" />
                                    No es
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </section>
          )}

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
                          <span className="font-mono text-[11px] text-cos-ink-faint">
                            {p.candidatas} candidatas{p.acumulativas ? ` · ${p.acumulativas} acumulativas fuera` : ""}
                          </span>
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
                            {opciones.map((c) => {
                              const acumulativa = c.subcuentas > 0;
                              return (
                                <li key={c.id}>
                                  <label
                                    className={cn(
                                      "flex items-baseline gap-3 rounded-md px-2 py-1.5",
                                      acumulativa
                                        ? "cursor-not-allowed text-cos-ink-faint"
                                        : eleccion === c.id ? "cursor-pointer bg-cos-brand-tint" : "cursor-pointer hover:bg-cos-card"
                                    )}
                                    title={acumulativa ? "Acumulativa: tiene subcuentas y no recibe pólizas" : undefined}
                                  >
                                    <input
                                      type="radio"
                                      name={`cand-${p.codigoMotor}`}
                                      checked={eleccion === c.id}
                                      disabled={acumulativa}
                                      onChange={() => setEleccion(c.id)}
                                      className="translate-y-0.5 accent-[--brand]"
                                    />
                                    <span className="w-20 shrink-0 font-mono text-[13px]">{c.codigo}</span>
                                    <span className={cn("min-w-0 flex-1 truncate text-[13px]", acumulativa ? "text-cos-ink-faint" : "text-cos-ink")}>{c.nombre}</span>
                                    {acumulativa ? (
                                      <span className="font-mono text-[11px] text-cos-ink-faint">acumulativa · {c.subcuentas} subcuentas</span>
                                    ) : c.codAgrup ? (
                                      <span className="font-mono text-[11px] text-cos-ink-faint">agrup {c.codAgrup}</span>
                                    ) : null}
                                  </label>
                                </li>
                              );
                            })}
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
          </>
          )}

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
              <div className="overflow-x-auto"><table className="w-full text-[13px]">
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
                          // En catálogo SAT nada declara agrupador: pintar 100+
                          // chips ámbar de «sin agrupador» sería puro ruido.
                          planPropio && c.nivel >= 3 ? (
                            <span className="rounded-full bg-cos-amber-tint px-2 py-0.5 font-sans text-[11px] font-semibold text-cos-amber-ink">
                              sin agrupador
                            </span>
                          ) : ""
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
