"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Money, Badge, Loading, Alert, type BadgeTone } from "@/components/ui";
import {
  ArrowLeft, CheckCircle2, Pencil, X, Loader2, Plus, Trash2, AlertTriangle, ShieldCheck,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Apertura fiscal — pantalla de revisión y confirmación del punto de partida.
// Cada dato muestra su PROCEDENCIA («del acuse de mayo de 2026», «capturado
// manualmente», «sin dato — captúralo») y los editables se corrigen en línea
// (PATCH /api/companies/[id]/apertura). El botón «Confirmar punto de partida»
// estampa quién y cuándo; las correcciones siguen abiertas después.
// ─────────────────────────────────────────────────────────────────────────────

interface Fuente { tipo: string; referencia?: string; etiqueta: string }
interface Apertura {
  primerPeriodo: string;
  periodoAnterior: string;
  esPersonaMoral: boolean;
  ivaSaldoFavor: { valor: number | null; fuente: Fuente; editable: boolean };
  coeficiente: { aplica: boolean; valor: number | null; anio: number | null; fuente: Fuente; editable: boolean };
  perdidaPendiente: { aplica: boolean; valor: number | null; ejercicio: number | null; fuente: Fuente; editable: boolean };
  perdidasPorAmortizar: { ejercicio: number; montoOriginal: number; saldoActualizado: number; fuente: Fuente }[];
  pagosProvisionalesEjercicio: { mes: number; periodo: string; isrPagado: number; fuente: Fuente }[];
  obligaciones: { tipo: string; descripcion: string; activa: boolean; fuente: Fuente }[];
  nomina: { empleadosActivos: number; corridasImportadas: number };
  sincronizacion: { periodosCubiertos: number; periodosTotales: number; faltantes: string[]; backfillTerminado: boolean };
  confirmada: boolean;
  confirmadaAt: string | null;
  confirmadaPor: string | null;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function nombrePeriodo(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MESES[m - 1]} de ${y}` : p;
}

function fmtFecha(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-MX", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const FUENTE_TONE: Record<string, BadgeTone> = {
  acuse: "info",
  manual: "neutral",
  calculado: "neutral",
  regimen: "neutral",
  csf: "info",
  nomina: "neutral",
  "sin-dato": "warning",
};

function FuenteBadge({ fuente }: { fuente: Fuente }) {
  return <Badge tone={FUENTE_TONE[fuente.tipo] ?? "neutral"}>{fuente.etiqueta}</Badge>;
}

/** Fila de revisión: título, valor, procedencia y edición en línea opcional. */
function Fila({
  titulo, descripcion, children,
}: { titulo: string; descripcion?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-cos-line-soft px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-cos-ink">{titulo}</p>
        {descripcion && <p className="mt-0.5 text-xs text-cos-ink-soft">{descripcion}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 sm:justify-end">{children}</div>
    </div>
  );
}

/** Editor en línea de un número (monto o coeficiente). */
function EditorNumero({
  valorInicial, decimales, placeholder, onGuardar, onCancelar, guardando,
}: {
  valorInicial: number | null;
  decimales: number;
  placeholder: string;
  onGuardar: (v: number | null) => void;
  onCancelar: () => void;
  guardando: boolean;
}) {
  const [texto, setTexto] = useState(valorInicial != null ? String(valorInicial) : "");
  const invalido = texto.trim() !== "" && (!Number.isFinite(Number(texto)) || Number(texto) < 0);
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        step={decimales >= 4 ? "0.0001" : "0.01"}
        min={0}
        value={texto}
        placeholder={placeholder}
        onChange={(e) => setTexto(e.target.value)}
        className="w-36 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-right font-mono text-sm text-cos-ink focus:border-cos-brand focus:outline-none"
        autoFocus
      />
      <button
        type="button"
        disabled={guardando || invalido}
        onClick={() => onGuardar(texto.trim() === "" ? null : Number(texto))}
        className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
      >
        {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
      </button>
      <button
        type="button"
        onClick={onCancelar}
        disabled={guardando}
        className="rounded-control border border-cos-line p-1.5 text-cos-ink-soft hover:bg-cos-paper"
        aria-label="Cancelar"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function AperturaFiscalPage() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [apertura, setApertura] = useState<Apertura | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editando, setEditando] = useState<string | null>(null); // clave del campo en edición
  const [guardando, setGuardando] = useState(false);
  const [revisado, setRevisado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [nuevaPerdida, setNuevaPerdida] = useState<{ ejercicio: string; saldo: string } | null>(null);

  const companyId = activeCompany?.id;

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/apertura`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo cargar la apertura");
      setApertura(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar la apertura");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { cargar(); }, [cargar]);

  const corregir = useCallback(
    async (body: Record<string, unknown>) => {
      if (!companyId) return;
      setGuardando(true);
      setError("");
      try {
        const res = await fetch(`/api/companies/${companyId}/apertura`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "No se pudo guardar la corrección");
        setApertura(data.apertura);
        setEditando(null);
        setNuevaPerdida(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo guardar la corrección");
      } finally {
        setGuardando(false);
      }
    },
    [companyId]
  );

  const confirmar = useCallback(async () => {
    if (!companyId) return;
    setConfirmando(true);
    setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/apertura/confirmar`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo confirmar");
      setRevisado(false);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo confirmar");
    } finally {
      setConfirmando(false);
    }
  }, [companyId, cargar]);

  if (companyLoading) return <div className="p-8 text-sm text-cos-ink-faint">Cargando…</div>;
  if (!activeCompany) {
    return (
      <div className="mx-auto mt-20 max-w-md p-8 text-center">
        <h2 className="text-lg font-semibold text-cos-ink">No hay empresas registradas</h2>
      </div>
    );
  }

  const botonEditar = (clave: string) => (
    <button
      type="button"
      onClick={() => setEditando(clave)}
      className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2 py-1 text-xs text-cos-ink-soft hover:bg-cos-paper"
    >
      <Pencil className="h-3 w-3" /> Corregir
    </button>
  );

  return (
    <div className="mx-auto max-w-[860px] px-4 py-6 sm:px-8 sm:py-8">
      <Link href="/empresa" className="mb-4 inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink">
        <ArrowLeft className="h-4 w-4" /> Mi empresa
      </Link>

      <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-cos-ink">Apertura fiscal</h1>
      <p className="mt-1 text-sm text-cos-ink-soft">
        Este es el punto de partida con el que la plataforma calcula tus impuestos: revisa de dónde
        salió cada dato, corrige lo que esté mal y confirma. Un error aquí se arrastra a todos los
        meses siguientes.
      </p>

      {error && (
        <Alert tone="danger" className="mt-4 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </Alert>
      )}

      {loading || !apertura ? (
        <Loading label="Armando el punto de partida…" className="py-16" />
      ) : (
        <div className="mt-5 space-y-5">
          {/* Estado de confirmación */}
          {apertura.confirmada && apertura.confirmadaAt && (
            <div className="flex items-start gap-3 rounded-card bg-cos-jade-tint px-5 py-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-cos-jade-ink" />
              <p className="text-sm text-cos-jade-ink">
                Punto de partida confirmado por <strong>{apertura.confirmadaPor}</strong> el{" "}
                {fmtFecha(apertura.confirmadaAt)}. Puedes seguir corrigiendo los datos; si cambias
                algo importante, vuelve a confirmar.
              </p>
            </div>
          )}

          {/* ── Arrastres iniciales ── */}
          <section className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <div className="border-b border-cos-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-cos-ink">Arrastres iniciales</h2>
              <p className="mt-0.5 text-xs text-cos-ink-soft">
                Primer mes calculado: <strong>{nombrePeriodo(apertura.primerPeriodo)}</strong> — el
                arrastre se toma de la declaración de {nombrePeriodo(apertura.periodoAnterior)}.
              </p>
            </div>

            <Fila
              titulo="Saldo a favor de IVA inicial"
              descripcion={`Saldo a favor de ${nombrePeriodo(apertura.periodoAnterior)} que se acredita en ${nombrePeriodo(apertura.primerPeriodo)} (Art. 6 LIVA).`}
            >
              {editando === "iva" ? (
                <EditorNumero
                  valorInicial={apertura.ivaSaldoFavor.valor}
                  decimales={2}
                  placeholder="0.00"
                  guardando={guardando}
                  onGuardar={(v) => corregir({ ivaSaldoFavorInicial: v })}
                  onCancelar={() => setEditando(null)}
                />
              ) : (
                <>
                  {apertura.ivaSaldoFavor.valor != null
                    ? <Money value={apertura.ivaSaldoFavor.valor} size={15} weight={600} />
                    : <span className="font-mono text-sm text-cos-ink-faint">—</span>}
                  <FuenteBadge fuente={apertura.ivaSaldoFavor.fuente} />
                  {apertura.ivaSaldoFavor.editable && botonEditar("iva")}
                </>
              )}
            </Fila>

            {apertura.coeficiente.aplica && (
              <Fila
                titulo="Coeficiente de utilidad"
                descripcion="Con el que se calculan los pagos provisionales de ISR (Art. 14 LISR)."
              >
                {editando === "coef" ? (
                  <EditorNumero
                    valorInicial={apertura.coeficiente.valor}
                    decimales={4}
                    placeholder="0.0000"
                    guardando={guardando}
                    onGuardar={(v) => corregir({ coeficiente: { valor: v, anio: new Date().getFullYear() } })}
                    onCancelar={() => setEditando(null)}
                  />
                ) : (
                  <>
                    <span className="font-mono text-sm font-semibold text-cos-ink">
                      {apertura.coeficiente.valor != null ? apertura.coeficiente.valor.toFixed(4) : "—"}
                    </span>
                    <FuenteBadge fuente={apertura.coeficiente.fuente} />
                    {apertura.coeficiente.editable && botonEditar("coef")}
                  </>
                )}
              </Fila>
            )}

            {apertura.perdidaPendiente.aplica && (
              <Fila
                titulo="Pérdidas por amortizar (remanente)"
                descripcion="Remanente actualizado de ejercicios anteriores que se resta de la utilidad estimada (Art. 14 LISR)."
              >
                {editando === "perdida" ? (
                  <EditorNumero
                    valorInicial={apertura.perdidaPendiente.valor}
                    decimales={2}
                    placeholder="0.00"
                    guardando={guardando}
                    onGuardar={(v) =>
                      corregir({ perdidaPendiente: { valor: v, anio: v == null ? null : new Date().getFullYear() - 1 } })
                    }
                    onCancelar={() => setEditando(null)}
                  />
                ) : (
                  <>
                    {apertura.perdidaPendiente.valor != null
                      ? <Money value={apertura.perdidaPendiente.valor} size={15} weight={600} />
                      : <span className="font-mono text-sm text-cos-ink-faint">—</span>}
                    <FuenteBadge fuente={apertura.perdidaPendiente.fuente} />
                    {apertura.perdidaPendiente.editable && botonEditar("perdida")}
                  </>
                )}
              </Fila>
            )}
          </section>

          {/* ── Pérdidas por ejercicio (ledger Art. 57) ── */}
          {(!apertura.esPersonaMoral || apertura.perdidasPorAmortizar.length > 0 || nuevaPerdida) && (
            <section className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
              <div className="flex items-center justify-between border-b border-cos-line px-5 py-3.5">
                <div>
                  <h2 className="text-sm font-semibold text-cos-ink">Pérdidas fiscales por ejercicio</h2>
                  <p className="mt-0.5 text-xs text-cos-ink-soft">
                    Se amortizan contra utilidades de los 10 ejercicios siguientes, actualizadas por INPC (Art. 57 LISR).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setNuevaPerdida({ ejercicio: "", saldo: "" })}
                  className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2 py-1 text-xs text-cos-ink-soft hover:bg-cos-paper"
                >
                  <Plus className="h-3 w-3" /> Agregar
                </button>
              </div>

              {apertura.perdidasPorAmortizar.length === 0 && !nuevaPerdida && (
                <p className="px-5 py-4 text-sm text-cos-ink-faint">Sin pérdidas registradas.</p>
              )}

              {apertura.perdidasPorAmortizar.map((p) => (
                <Fila key={p.ejercicio} titulo={`Ejercicio ${p.ejercicio}`} descripcion={`Monto original $${p.montoOriginal.toLocaleString("en-US")}`}>
                  <Money value={p.saldoActualizado} size={15} weight={600} />
                  <FuenteBadge fuente={p.fuente} />
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() => corregir({ perdidasEliminar: [p.ejercicio] })}
                    className="rounded-control border border-cos-line p-1.5 text-cos-ink-soft hover:bg-cos-red-tint hover:text-cos-red-ink"
                    aria-label={`Eliminar pérdida ${p.ejercicio}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Fila>
              ))}

              {nuevaPerdida && (
                <div className="flex flex-wrap items-center gap-2 border-t border-cos-line-soft px-5 py-4">
                  <input
                    type="number"
                    placeholder="Ejercicio (p. ej. 2024)"
                    value={nuevaPerdida.ejercicio}
                    onChange={(e) => setNuevaPerdida({ ...nuevaPerdida, ejercicio: e.target.value })}
                    className="w-40 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 font-mono text-sm focus:border-cos-brand focus:outline-none"
                  />
                  <input
                    type="number"
                    placeholder="Saldo pendiente"
                    value={nuevaPerdida.saldo}
                    onChange={(e) => setNuevaPerdida({ ...nuevaPerdida, saldo: e.target.value })}
                    className="w-40 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 font-mono text-sm focus:border-cos-brand focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={
                      guardando ||
                      !Number.isInteger(Number(nuevaPerdida.ejercicio)) ||
                      Number(nuevaPerdida.ejercicio) < 1990 ||
                      !(Number(nuevaPerdida.saldo) >= 0) ||
                      nuevaPerdida.saldo.trim() === ""
                    }
                    onClick={() =>
                      corregir({ perdidas: [{ ejercicio: Number(nuevaPerdida.ejercicio), saldoActualizado: Number(nuevaPerdida.saldo) }] })
                    }
                    className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                  >
                    {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNuevaPerdida(null)}
                    className="rounded-control border border-cos-line p-1.5 text-cos-ink-soft hover:bg-cos-paper"
                    aria-label="Cancelar"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </section>
          )}

          {/* ── Pagos provisionales del ejercicio ── */}
          <section className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <div className="border-b border-cos-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-cos-ink">Pagos provisionales de ISR del ejercicio</h2>
              <p className="mt-0.5 text-xs text-cos-ink-soft">
                Se acreditan contra los provisionales de los meses siguientes (Art. 14 LISR).
              </p>
            </div>
            {apertura.pagosProvisionalesEjercicio.length === 0 ? (
              <p className="px-5 py-4 text-sm text-cos-ink-faint">
                Sin pagos provisionales guardados en el ejercicio.
              </p>
            ) : (
              apertura.pagosProvisionalesEjercicio.map((p) => (
                <Fila key={p.periodo} titulo={nombrePeriodo(p.periodo)}>
                  <Money value={p.isrPagado} size={15} weight={600} />
                  <FuenteBadge fuente={p.fuente} />
                </Fila>
              ))
            )}
          </section>

          {/* ── Obligaciones ── */}
          <section className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <div className="border-b border-cos-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-cos-ink">Obligaciones registradas</h2>
              <p className="mt-0.5 text-xs text-cos-ink-soft">
                Definen qué declaraciones se esperan cada periodo. Desactiva las que no correspondan.
              </p>
            </div>
            {apertura.obligaciones.length === 0 ? (
              <p className="px-5 py-4 text-sm text-cos-ink-faint">Sin obligaciones registradas.</p>
            ) : (
              apertura.obligaciones.map((o) => (
                <Fila key={o.tipo} titulo={o.descripcion} descripcion={o.tipo}>
                  <FuenteBadge fuente={o.fuente} />
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() => corregir({ obligaciones: [{ tipo: o.tipo, activa: !o.activa }] })}
                    className={`rounded-control px-2.5 py-1 text-xs font-semibold ${
                      o.activa
                        ? "bg-cos-jade-tint text-cos-jade-ink hover:opacity-80"
                        : "bg-cos-slate-tint text-cos-ink-soft hover:opacity-80"
                    }`}
                  >
                    {o.activa ? "Activa" : "Inactiva"}
                  </button>
                </Fila>
              ))
            )}
          </section>

          {/* ── Nómina y sincronización (informativos) ── */}
          <section className="overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
            <div className="border-b border-cos-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-cos-ink">Nómina y cobertura de datos</h2>
            </div>
            <Fila titulo="Empleados activos">
              <span className="font-mono text-sm font-semibold text-cos-ink">{apertura.nomina.empleadosActivos}</span>
            </Fila>
            <Fila titulo="Corridas de nómina reconstruidas del SAT">
              <span className="font-mono text-sm font-semibold text-cos-ink">{apertura.nomina.corridasImportadas}</span>
            </Fila>
            <Fila
              titulo="Sincronización con el SAT"
              descripcion={
                apertura.sincronizacion.faltantes.length > 0
                  ? `Periodos pendientes: ${apertura.sincronizacion.faltantes.slice(0, 6).join(", ")}${apertura.sincronizacion.faltantes.length > 6 ? "…" : ""}`
                  : undefined
              }
            >
              <span className="font-mono text-sm font-semibold text-cos-ink">
                {apertura.sincronizacion.periodosCubiertos} / {apertura.sincronizacion.periodosTotales} periodos
              </span>
              {apertura.sincronizacion.backfillTerminado ? (
                <Badge tone="success">descarga histórica completa</Badge>
              ) : (
                <Badge tone="warning">descarga en curso</Badge>
              )}
            </Fila>
          </section>

          {/* ── Confirmación ── */}
          <section className="rounded-card border border-cos-line bg-cos-card p-5 shadow-card">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={revisado}
                onChange={(e) => setRevisado(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-cos-line accent-cos-brand"
              />
              <span className="text-sm text-cos-ink">
                Revisé estos datos y son correctos. Entiendo que los cálculos de todos los meses
                parten de este punto.
              </span>
            </label>
            <button
              type="button"
              disabled={!revisado || confirmando}
              onClick={confirmar}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50 sm:w-auto"
            >
              {confirmando ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {apertura.confirmada ? "Volver a confirmar punto de partida" : "Confirmar punto de partida"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
