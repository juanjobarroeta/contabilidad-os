"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Ajustes: captura de pólizas a la altura de COI (brief UX, módulo P0-3).
// Teclado primero: autocompletar cuenta por código o nombre, Tab avanza,
// Enter agrega renglón, ⌘D duplica, pegar desde Excel, descuadre vivo, y
// no se guarda descuadrada. Fuente MANUAL — el re-posteo nunca la pisa.
//
// Deep-link desde Divergencia: ?cuenta=&monto=&concepto= prellenan el primer
// renglón (adoptar la diferencia como póliza de ajuste).
//
// Reemplaza a la captura por <select> del editor modal de LibroPanels: un
// select por renglón obliga al mouse y no busca por nombre («gasolina»).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { Money } from "@/components/ui/Money";
import { cn } from "@/lib/utils";

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface CuentaOpcion { codigo: string; nombre: string }
interface Linea { cuenta: string; concepto: string; cargo: string; abono: string }
interface PolizaManual {
  folio: string;
  fecha: string;
  concepto: string;
  fuente: string;
  totalCargos: number;
  transacciones: Array<{ numCta: string; concepto: string; cargo: number; abono: number }>;
}

const LINEA_VACIA: Linea = { cuenta: "", concepto: "", cargo: "", abono: "" };

/** "1,234.56" / "$1,234.56" → número; vacío → 0. */
function num(s: string): number {
  const limpio = s.replace(/[$,\s]/g, "");
  return limpio ? Number(limpio) || 0 : 0;
}

/** Último día del período, en formato del input date. */
function finDeMes(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

// ── Página ────────────────────────────────────────────────────────────────────
export default function AjustesPage() {
  const { activeCompany } = useCompany();
  const { year, month, label } = usePeriod();

  const [cuentas, setCuentas] = useState<CuentaOpcion[]>([]);
  const [manuales, setManuales] = useState<PolizaManual[] | null>(null);

  const [fecha, setFecha] = useState(finDeMes(year, month));
  const [concepto, setConcepto] = useState("");
  const [lineas, setLineas] = useState<Linea[]>([{ ...LINEA_VACIA }, { ...LINEA_VACIA }]);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");

  // Autocompletar: qué celda de cuenta está abierta y qué opción va resaltada.
  const [acFila, setAcFila] = useState<number | null>(null);
  const [acCursor, setAcCursor] = useState(0);
  const prellenado = useRef(false);

  useEffect(() => { setFecha(finDeMes(year, month)); }, [year, month]);

  // Catálogo para el autocompletar (mismo origen que el editor de LibroPanels).
  useEffect(() => {
    if (!activeCompany) return;
    (async () => {
      const res = await fetch(`/api/contabilidad/apertura?companyId=${activeCompany.id}`);
      const d = await res.json().catch(() => null);
      const cs: CuentaOpcion[] = (d?.cuentas ?? [])
        .filter((c: { nivel: number }) => c.nivel >= 3)
        .map((c: { cuentaSAT: string; subcuenta: string | null; nombre: string }) => ({
          codigo: c.subcuenta ?? c.cuentaSAT,
          nombre: c.nombre,
        }));
      setCuentas(cs);
    })();
  }, [activeCompany]);

  // Pólizas manuales del período (el libro filtrado a fuente MANUAL).
  const cargarManuales = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(
      `/api/contabilidad/libro-diario?companyId=${activeCompany.id}&year=${year}&month=${month}`
    );
    const d = await res.json().catch(() => null);
    setManuales(((d?.polizas ?? []) as PolizaManual[]).filter((p) => p.fuente === "MANUAL"));
  }, [activeCompany, year, month]);

  useEffect(() => { setManuales(null); cargarManuales(); }, [cargarManuales]);

  // Deep-link de Divergencia: prellenar una vez.
  useEffect(() => {
    if (prellenado.current) return;
    const p = new URLSearchParams(window.location.search);
    const cuenta = p.get("cuenta");
    const monto = p.get("monto");
    if (!cuenta && !p.get("concepto")) return;
    prellenado.current = true;
    if (p.get("concepto")) setConcepto(p.get("concepto")!);
    if (cuenta) {
      setLineas([
        { cuenta, concepto: "", cargo: monto ?? "", abono: "" },
        { ...LINEA_VACIA },
      ]);
    }
  }, []);

  // ── Derivados ────────────────────────────────────────────────────────────────
  const totalCargos = lineas.reduce((s, l) => s + num(l.cargo), 0);
  const totalAbonos = lineas.reduce((s, l) => s + num(l.abono), 0);
  const descuadre = Math.round((totalCargos - totalAbonos) * 100) / 100;
  const lineasValidas = lineas.filter((l) => l.cuenta && (num(l.cargo) > 0 || num(l.abono) > 0));
  const cuadrada = Math.abs(descuadre) < 0.01 && totalCargos > 0 && lineasValidas.length >= 2;

  const opciones = useMemo(() => {
    if (acFila === null) return [];
    const q = (lineas[acFila]?.cuenta ?? "").trim().toLowerCase();
    if (!q) return cuentas.slice(0, 8);
    return cuentas
      .filter((c) => c.codigo.toLowerCase().startsWith(q) || c.nombre.toLowerCase().includes(q))
      .slice(0, 8);
  }, [acFila, lineas, cuentas]);

  const nombreDe = useCallback(
    (codigo: string) => cuentas.find((c) => c.codigo === codigo)?.nombre ?? "",
    [cuentas]
  );

  // ── Mutaciones del grid ─────────────────────────────────────────────────────
  function setLinea(i: number, patch: Partial<Linea>) {
    setLineas((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  function foco(i: number, col: string) {
    requestAnimationFrame(() => document.getElementById(`celda-${i}-${col}`)?.focus());
  }

  function agregarRenglon(desde: number) {
    setLineas((prev) => [...prev.slice(0, desde + 1), { ...LINEA_VACIA }, ...prev.slice(desde + 1)]);
    foco(desde + 1, "cuenta");
  }

  function duplicarRenglon(i: number) {
    setLineas((prev) => [...prev.slice(0, i + 1), { ...prev[i] }, ...prev.slice(i + 1)]);
    foco(i + 1, "cuenta");
  }

  function quitarRenglon(i: number) {
    setLineas((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  }

  function elegirCuenta(i: number, c: CuentaOpcion) {
    setLinea(i, { cuenta: c.codigo });
    setAcFila(null);
    foco(i, "concepto");
  }

  /** Pegar desde Excel: columnas cuenta / concepto / cargo / abono. */
  function pegar(e: React.ClipboardEvent, filaBase: number) {
    const texto = e.clipboardData.getData("text/plain");
    if (!texto.includes("\t") && !texto.includes("\n")) return; // pegado normal
    e.preventDefault();
    const filas = texto
      .split(/\r?\n/)
      .filter((r) => r.trim())
      .map((r) => {
        const [cuenta = "", concepto = "", cargo = "", abono = ""] = r.split("\t");
        return { cuenta: cuenta.trim(), concepto: concepto.trim(), cargo: cargo.trim(), abono: abono.trim() };
      });
    if (filas.length === 0) return;
    setLineas((prev) => {
      const antes = prev.slice(0, filaBase);
      const despues = prev.slice(filaBase + 1).filter((l) => l.cuenta || l.cargo || l.abono);
      return [...antes, ...filas, ...despues];
    });
    setAcFila(null);
  }

  function teclas(e: React.KeyboardEvent, i: number, col: "cuenta" | "concepto" | "cargo" | "abono") {
    // ⌘D / Ctrl+D: duplicar renglón.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicarRenglon(i);
      return;
    }
    // ⌘Enter: guardar.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (cuadrada && !guardando) guardar();
      return;
    }
    if (col === "cuenta" && acFila === i && opciones.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcCursor((c) => Math.min(c + 1, opciones.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcCursor((c) => Math.max(c - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        elegirCuenta(i, opciones[acCursor]);
        return;
      }
      if (e.key === "Escape") { setAcFila(null); return; }
    }
    // Enter en la última celda → nuevo renglón (como COI).
    if (e.key === "Enter" && col === "abono") {
      e.preventDefault();
      agregarRenglon(i);
    }
  }

  async function guardar() {
    if (!activeCompany || !cuadrada) return;
    setGuardando(true); setError(""); setAviso("");
    try {
      const res = await fetch("/api/contabilidad/polizas-manuales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          fecha,
          concepto,
          lineas: lineasValidas.map((l) => ({
            cuenta: l.cuenta,
            concepto: l.concepto || undefined,
            cargo: num(l.cargo),
            abono: num(l.abono),
          })),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo guardar la póliza");
      setAviso(`Póliza guardada — ${lineasValidas.length} renglones por $${totalCargos.toLocaleString("en-US", { minimumFractionDigits: 2 })}.`);
      setLineas([{ ...LINEA_VACIA }, { ...LINEA_VACIA }]);
      setConcepto("");
      await cargarManuales();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la póliza");
    } finally {
      setGuardando(false);
    }
  }

  /** Volver a capturar una póliza existente (recurrentes v1). */
  function usarComoPlantilla(p: PolizaManual) {
    setConcepto(p.concepto);
    setLineas([
      ...p.transacciones.map((t) => ({
        cuenta: t.numCta,
        concepto: t.concepto,
        cargo: t.cargo > 0 ? String(t.cargo) : "",
        abono: t.abono > 0 ? String(t.abono) : "",
      })),
      { ...LINEA_VACIA },
    ]);
    window.scrollTo({ top: 0, behavior: "smooth" });
    foco(0, "cuenta");
  }

  if (!activeCompany) return null;

  const celda = "w-full bg-transparent px-3 py-0 h-[38px] text-[13px] text-cos-ink focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cos-brand rounded-sm";
  const celdaNum = cn(celda, "text-right font-mono tabular-nums");
  const thCls = "px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-cos-ink-faint text-left";

  return (
    <div>
      <FlowPageHeader
        title="Nueva póliza"
        subtitle={`${label} · fuente MANUAL`}
        actions={
          <span className="rounded-full bg-cos-brand-tint px-3 py-1.5 text-[12px] font-medium text-cos-brand-ink">
            Fuente MANUAL — el re-posteo nunca la pisa
          </span>
        }
      />

      {aviso && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink">
          <Check className="h-4 w-4 shrink-0" /> <span className="flex-1">{aviso}</span>
          <button onClick={() => setAviso("")} aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Cerrar error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* ── Encabezado de la póliza ── */}
      <div className="mb-4 rounded-card border border-cos-line bg-cos-card px-5 py-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-cos-ink-faint">Fecha</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm"
            />
          </label>
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-cos-ink-faint">Concepto</span>
            <input
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              placeholder="Ej. Ajuste por divergencia CE / provisión de renta"
              className="w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm placeholder:text-cos-ink-faint"
            />
          </label>
        </div>
      </div>

      {/* ── Reja de captura ── */}
      <div className="rounded-card border border-cos-line bg-cos-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-cos-line">
              <th className={cn(thCls, "w-10")}>#</th>
              <th className={cn(thCls, "w-[300px]")}>Cuenta</th>
              <th className={thCls}>Concepto</th>
              <th className={cn(thCls, "w-36 text-right")}>Cargo</th>
              <th className={cn(thCls, "w-36 text-right")}>Abono</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lineas.map((l, i) => {
              const abiertoAqui = acFila === i && opciones.length > 0;
              return (
                <tr key={i} className="border-b border-cos-line-soft align-top">
                  <td className="px-3 py-0 h-[38px] align-middle font-mono text-[12px] text-cos-ink-faint">{i + 1}</td>
                  <td className="relative p-0">
                    <div className="flex items-center">
                      <input
                        id={`celda-${i}-cuenta`}
                        value={l.cuenta}
                        role="combobox"
                        aria-expanded={abiertoAqui}
                        aria-controls={`ac-lista-${i}`}
                        aria-activedescendant={abiertoAqui ? `ac-${i}-${acCursor}` : undefined}
                        aria-autocomplete="list"
                        aria-label={`Cuenta del renglón ${i + 1}`}
                        onChange={(e) => { setLinea(i, { cuenta: e.target.value }); setAcFila(i); setAcCursor(0); }}
                        onFocus={() => { setAcFila(i); setAcCursor(0); }}
                        onBlur={() => setTimeout(() => setAcFila((f) => (f === i ? null : f)), 150)}
                        onKeyDown={(e) => teclas(e, i, "cuenta")}
                        onPaste={(e) => pegar(e, i)}
                        placeholder="código o nombre"
                        className={cn(celda, "w-24 shrink-0 font-mono")}
                      />
                      <span className="truncate pr-2 text-[13px] text-cos-ink-soft">{nombreDe(l.cuenta)}</span>
                    </div>
                    {abiertoAqui && (
                      <ul
                        id={`ac-lista-${i}`}
                        role="listbox"
                        aria-label="Cuentas"
                        className="absolute left-0 top-full z-30 mt-0.5 w-[340px] rounded-card border border-cos-line bg-cos-card py-1 shadow-card"
                      >
                        {opciones.map((c, j) => (
                          <li
                            key={c.codigo}
                            id={`ac-${i}-${j}`}
                            role="option"
                            aria-selected={j === acCursor}
                            onMouseDown={(e) => { e.preventDefault(); elegirCuenta(i, c); }}
                            onMouseEnter={() => setAcCursor(j)}
                            className={cn(
                              "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 font-mono text-[13px]",
                              j === acCursor ? "bg-cos-brand-tint text-cos-brand-ink" : "text-cos-ink"
                            )}
                          >
                            <span>{c.codigo}</span>
                            <span className="truncate text-right">{c.nombre}</span>
                          </li>
                        ))}
                        <li role="presentation" className="border-t border-cos-line-soft px-3 pb-0.5 pt-1.5 text-[11px] text-cos-ink-faint">
                          también busca por nombre: «gasolina» → combustibles
                        </li>
                      </ul>
                    )}
                  </td>
                  <td className="p-0">
                    <input
                      id={`celda-${i}-concepto`}
                      value={l.concepto}
                      aria-label={`Concepto del renglón ${i + 1}`}
                      onChange={(e) => setLinea(i, { concepto: e.target.value })}
                      onKeyDown={(e) => teclas(e, i, "concepto")}
                      className={celda}
                    />
                  </td>
                  <td className="p-0">
                    <input
                      id={`celda-${i}-cargo`}
                      value={l.cargo}
                      aria-label={`Cargo del renglón ${i + 1}`}
                      inputMode="decimal"
                      placeholder="—"
                      onChange={(e) => setLinea(i, { cargo: e.target.value })}
                      onKeyDown={(e) => teclas(e, i, "cargo")}
                      className={celdaNum}
                    />
                  </td>
                  <td className="p-0">
                    <input
                      id={`celda-${i}-abono`}
                      value={l.abono}
                      aria-label={`Abono del renglón ${i + 1}`}
                      inputMode="decimal"
                      placeholder="—"
                      onChange={(e) => setLinea(i, { abono: e.target.value })}
                      onKeyDown={(e) => teclas(e, i, "abono")}
                      className={celdaNum}
                    />
                  </td>
                  <td className="px-1 py-0 h-[38px] align-middle">
                    <button
                      onClick={() => quitarRenglon(i)}
                      aria-label={`Quitar renglón ${i + 1}`}
                      tabIndex={-1}
                      className="rounded p-1 text-cos-ink-faint opacity-60 hover:bg-cos-paper hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* ── Barra de descuadre vivo ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-card border-t border-cos-line bg-cos-slate-tint px-5 py-3">
          <span className="text-[13px] text-cos-ink-soft">
            {lineas.length} renglones
          </span>
          <div className="flex flex-wrap items-center gap-6">
            <div className="text-right">
              <p className="font-mono text-[10px] uppercase tracking-wider text-cos-ink-faint">Cargos</p>
              <Money value={totalCargos} size={16} />
            </div>
            <div className="text-right">
              <p className="font-mono text-[10px] uppercase tracking-wider text-cos-ink-faint">Abonos</p>
              <Money value={totalAbonos} size={16} />
            </div>
            <div className="text-right">
              <p className="font-mono text-[10px] uppercase tracking-wider text-cos-ink-faint">Descuadre</p>
              <span className="flex items-center gap-1">
                <Money
                  value={descuadre}
                  size={16}
                  className={cuadrada ? "text-cos-jade-ink" : Math.abs(descuadre) < 0.01 ? undefined : "text-cos-red-ink"}
                />
                {cuadrada && <Check className="h-4 w-4 text-cos-jade-ink" />}
              </span>
              {cuadrada && <p className="text-[11px] font-medium text-cos-jade-ink">Cuadrada</p>}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <button
                onClick={guardar}
                disabled={!cuadrada || guardando}
                className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
                Guardar póliza
              </button>
              <span className="text-[11px] text-cos-ink-faint">no se guarda descuadrada</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Atajos ── */}
      <p className="mt-3 text-center font-mono text-[12px] text-cos-ink-faint">
        Tab avanza · Enter en abono agrega renglón · ⌘D duplica renglón · pega desde Excel
        (cuenta / concepto / cargo / abono) · ⌘Enter guarda · Esc cierra el autocompletar
      </p>

      {/* ── Pólizas manuales del período ── */}
      <section className="mt-6 rounded-card border border-cos-line bg-cos-card">
        <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
          Pólizas manuales de {label.toLowerCase()}
        </h2>
        {manuales === null ? (
          <p className="flex items-center gap-2 px-5 py-6 text-sm text-cos-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </p>
        ) : manuales.length === 0 ? (
          <p className="px-5 py-6 text-sm text-cos-ink-soft">
            Sin pólizas manuales este mes. Los ajustes que captures arriba aparecerán aquí — y
            sobreviven al re-posteo.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-cos-line">
                <th className={cn(thCls, "w-32")}>Número</th>
                <th className={cn(thCls, "w-28")}>Fecha</th>
                <th className={thCls}>Concepto</th>
                <th className={cn(thCls, "w-36 text-right")}>Importe</th>
                <th className={cn(thCls, "w-28")}>Origen</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {manuales.map((p) => (
                <tr key={p.folio} className="h-[38px] border-b border-cos-line-soft hover:bg-cos-paper">
                  <td className="px-3 py-0 font-mono text-[12px] text-cos-ink-soft">{p.folio}</td>
                  <td className="px-3 py-0 font-mono text-[12px] tabular-nums">
                    {new Date(p.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" })}
                  </td>
                  <td className="max-w-[280px] truncate px-3 py-0">{p.concepto}</td>
                  <td className="px-3 py-0 text-right"><Money value={p.totalCargos} className="text-[13px]" /></td>
                  <td className="px-3 py-0">
                    <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 text-[11px] font-semibold text-cos-brand-ink">
                      MANUAL
                    </span>
                  </td>
                  <td className="px-3 py-0 text-right">
                    <button
                      onClick={() => usarComoPlantilla(p)}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-cos-brand-ink hover:underline"
                    >
                      <Copy className="h-3 w-3" /> Duplicar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
