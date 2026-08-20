"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Divergencia derivado ↔ declarado (brief UX, módulo P0-2): la pantalla que
// nadie más tiene. Lo que el motor derivó de los documentos contra lo que el
// contador presentó al SAT, rubro → cuenta, con drill a los CFDIs de cada
// renglón y adopción de la diferencia como póliza de ajuste.
//
// Datos: ce-estado-resultados (rubros 4xxx–8xxx con declarado/derivado por
// cuenta; excluye APERTURA/CIERRE) y cuenta-documentos (los asientos y CFDIs
// detrás del número derivado). El semáforo es RELATIVO AL RUBRO, no al valor
// absoluto. diferencia = derivado − declarado, con el signo de aporte al
// resultado (haber − debe).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2, X, ArrowRight, Target } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { Money } from "@/components/ui/Money";
import { StatTile, StatStrip } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { EstadoResultadosCe, Rubro, RenglonCuenta } from "@/lib/contabilidad/estado-resultados-ce";

// ── Respuesta de cuenta-documentos ────────────────────────────────────────────
interface DocumentoCuenta {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  fuente: string;
  invoice: {
    uuid: string;
    serie: string | null;
    folio: string | null;
    contraparte: string | null;
    importe: number;
  } | null;
}
interface CuentaDocumentos {
  cuenta: string;
  total: number;
  mostrados: number;
  neto: number;
  documentos: DocumentoCuenta[];
}

// ── Semáforo relativo al rubro ────────────────────────────────────────────────
type Semaforo = "cuadra" | "menor" | "revisar";

function semaforoDe(dif: number, rubro: Rubro): { s: Semaforo; pct: number } {
  const base = Math.max(Math.abs(rubro.derivado), Math.abs(rubro.declarado));
  const pct = base > 0.005 ? Math.abs(dif) / base : 0;
  if (Math.abs(dif) < 0.005) return { s: "cuadra", pct: 0 };
  return { s: pct >= 0.1 ? "revisar" : "menor", pct };
}

const CHIP_SEM: Record<Semaforo, { t: string; cls: string }> = {
  cuadra: { t: "Cuadra", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  menor: { t: "Menor", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  revisar: { t: "Revisar", cls: "bg-cos-red-tint text-cos-red-ink" },
};

function ChipSemaforo({ s }: { s: Semaforo }) {
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11.5px] font-semibold", CHIP_SEM[s].cls)}>
      {CHIP_SEM[s].t}
    </span>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────
export default function DivergenciaPage() {
  const { activeCompany } = useCompany();
  const { year, month, label } = usePeriod();

  const [data, setData] = useState<EstadoResultadosCe | null>(null);
  const [cargando, setCargando] = useState(true);
  const [soloDif, setSoloDif] = useState(true);
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<{ cuenta: RenglonCuenta; rubro: Rubro } | null>(null);
  const [docs, setDocs] = useState<CuentaDocumentos | null>(null);
  const [docsCargando, setDocsCargando] = useState(false);

  const cargar = useCallback(async () => {
    if (!activeCompany) return;
    setCargando(true);
    setSel(null);
    setDocs(null);
    try {
      const res = await fetch(
        `/api/contabilidad/ce-estado-resultados?companyId=${activeCompany.id}&anio=${year}&mes=${month}`
      );
      const d = await res.json();
      if (res.ok && Array.isArray(d?.rubros)) {
        setData(d);
        // Abrir de entrada los rubros con diferencia: ahí vive el trabajo.
        setAbiertos(
          new Set(
            (d.rubros as Rubro[])
              .filter((r) => Math.abs(r.diferencia) >= 0.005)
              .map((r) => r.clave)
          )
        );
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setCargando(false);
    }
  }, [activeCompany, year, month]);

  useEffect(() => { cargar(); }, [cargar]);

  // Drill de la cuenta seleccionada a sus documentos.
  useEffect(() => {
    if (!sel || !activeCompany) return;
    let vivo = true;
    setDocsCargando(true);
    setDocs(null);
    fetch(
      `/api/contabilidad/cuenta-documentos?companyId=${activeCompany.id}&cuenta=${encodeURIComponent(sel.cuenta.numCta)}&anio=${year}&mes=${month}&limit=8`
    )
      .then((r) => r.json())
      .then((d) => { if (vivo && d?.documentos) setDocs(d); })
      .catch(() => {})
      .finally(() => { if (vivo) setDocsCargando(false); });
    return () => { vivo = false; };
  }, [sel, activeCompany, year, month]);

  if (!activeCompany) return null;

  const presentado = data?.presentado ?? false;
  const todasCuentas = (data?.rubros ?? []).flatMap((r) => r.cuentas);
  const totalCuentas = todasCuentas.length;
  const cuentasConDif = todasCuentas.filter((c) => Math.abs(c.diferencia) >= 0.005).length;
  const rubrosVisibles = (data?.rubros ?? [])
    .map((r) => ({
      ...r,
      cuentas: soloDif && presentado
        ? r.cuentas.filter((c) => Math.abs(c.diferencia) >= 0.005)
        : r.cuentas,
    }))
    .filter((r) => r.cuentas.length > 0 || !soloDif);

  function toggleRubro(clave: string) {
    setAbiertos((prev) => {
      const s = new Set(prev);
      if (s.has(clave)) s.delete(clave); else s.add(clave);
      return s;
    });
  }

  const th = "px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-cos-ink-faint";
  const tdNum = "px-3 py-0 text-right font-mono tabular-nums";

  return (
    <div>
      <FlowPageHeader
        title="Divergencia"
        subtitle="Lo que el sistema derivó de tus documentos, contra lo que presentaste al SAT"
        context={
          data
            ? `${data.rubros.length} rubros · ${totalCuentas} cuentas con movimiento${presentado ? ` · ${cuentasConDif} con diferencia` : " · sin balanza presentada"}`
            : undefined
        }
        actions={
          data && presentado ? (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-cos-ink-soft">
              <input
                type="checkbox"
                checked={soloDif}
                onChange={(e) => setSoloDif(e.target.checked)}
                className="h-4 w-4 accent-[--brand]"
              />
              Sólo con diferencia
            </label>
          ) : null
        }
      />

      {cargando ? (
        <div className="flex items-center gap-2 rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> Comparando derivado contra declarado…
        </div>
      ) : !data ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
          No se pudo calcular la divergencia del período. Revisa que el mes tenga asientos posteados.
        </div>
      ) : (
        <>
          {!presentado && (
            <div className="mb-4 rounded-card border border-cos-line bg-cos-slate-tint px-4 py-3 text-sm text-cos-ink">
              <span className="font-medium">Sin balanza presentada para {label}</span> — sólo se
              muestra lo derivado. Importa la balanza CE del período para medir la divergencia.{" "}
              <Link href="/contabilidad/presentado" className="font-medium text-cos-brand-ink hover:underline">
                Ver presentadas
              </Link>
            </div>
          )}

          {/* ── Franja de stats (idioma del deck) ── */}
          <StatStrip>
            <StatTile label="Derivado" value={<Money value={data.resultado.derivado} size={20} />} />
            {presentado && (
              <StatTile label="Declarado" value={<Money value={data.resultado.declarado} size={20} />} />
            )}
            {presentado && (
              <StatTile
                label="Diferencia"
                tone={Math.abs(data.resultado.diferencia) >= 0.005 ? "red" : "jade"}
                value={
                  <Money
                    value={data.resultado.diferencia}
                    size={20}
                    className={Math.abs(data.resultado.diferencia) >= 0.005 ? "text-cos-red-ink" : "text-cos-jade-ink"}
                  />
                }
                sub="derivado − declarado"
              />
            )}
            <StatTile
              label="Cuentas con diferencia"
              tone={cuentasConDif > 0 ? "amber" : "jade"}
              value={presentado ? cuentasConDif : "—"}
              sub={presentado ? `de ${totalCuentas} con movimiento` : "sin balanza presentada"}
            />
          </StatStrip>

          <div className={cn("grid grid-cols-1 gap-5", sel && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
            {/* ── Tabla rubro → cuenta ── */}
            <div className="overflow-x-auto rounded-card border border-cos-line bg-cos-card">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-cos-line text-left">
                    <th className={cn(th, "w-24")}>Cuenta</th>
                    <th className={th}>Nombre</th>
                    <th className={cn(th, "w-24")}>Estado</th>
                    <th className={cn(th, "w-32 text-right")}>Derivado</th>
                    {presentado && <th className={cn(th, "w-32 text-right")}>Declarado</th>}
                    {presentado && <th className={cn(th, "w-32 text-right")}>Diferencia</th>}
                  </tr>
                </thead>
                <tbody>
                  {rubrosVisibles.map((rubro) => {
                    const semR = semaforoDe(rubro.diferencia, rubro);
                    const abierto = abiertos.has(rubro.clave);
                    return (
                      <RubroFilas
                        key={rubro.clave}
                        rubro={rubro}
                        sem={semR.s}
                        abierto={abierto}
                        presentado={presentado}
                        selCuenta={sel?.cuenta.numCta ?? null}
                        onToggle={() => toggleRubro(rubro.clave)}
                        onSelect={(c) => setSel({ cuenta: c, rubro })}
                        tdNum={tdNum}
                      />
                    );
                  })}
                  {/* Totales */}
                  <tr className="border-t border-cos-line bg-cos-slate-tint font-semibold">
                    <td className="px-3 py-2 font-mono text-[12px]">TOTAL</td>
                    <td className="px-3 py-2">Resultado del período</td>
                    <td />
                    <td className={cn(tdNum, "py-2")}><Money value={data.resultado.derivado} /></td>
                    {presentado && <td className={cn(tdNum, "py-2")}><Money value={data.resultado.declarado} /></td>}
                    {presentado && (
                      <td className={cn(tdNum, "py-2")}>
                        <Money
                          value={data.resultado.diferencia}
                          className={Math.abs(data.resultado.diferencia) >= 0.005 ? "text-cos-red-ink" : undefined}
                        />
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
              {rubrosVisibles.length === 0 && (
                <p className="px-5 py-8 text-center text-sm text-cos-ink-soft">
                  Sin diferencias en el período — residuo $0.00. Quita el filtro para ver todas las cuentas.
                </p>
              )}
            </div>

            {/* ── Panel de la cuenta seleccionada ── */}
            {sel && (
              <aside className="h-fit rounded-card border border-cos-line bg-cos-card">
                <div className="flex items-start justify-between gap-2 border-b border-cos-line px-5 py-3.5">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-cos-ink-faint">
                      Cuenta seleccionada
                    </p>
                    <h2 className="mt-0.5 text-sm font-semibold text-cos-ink">
                      <span className="font-mono">{sel.cuenta.numCta}</span> · {sel.cuenta.nombre || "(sin nombre)"}
                    </h2>
                  </div>
                  <button
                    onClick={() => setSel(null)}
                    aria-label="Cerrar panel"
                    className="rounded p-1 text-cos-ink-faint hover:bg-cos-paper"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-4 px-5 py-4 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-cos-line bg-cos-paper px-3 py-2">
                      <p className="text-[11px] font-medium text-cos-ink-soft">
                        Derivado{docs ? ` — ${docs.total} asientos` : ""}
                      </p>
                      <Money value={sel.cuenta.derivado} size={16} />
                    </div>
                    <div className="rounded-md border border-cos-line bg-cos-paper px-3 py-2">
                      <p className="text-[11px] font-medium text-cos-ink-soft">Declarado — balanza CE</p>
                      {presentado ? <Money value={sel.cuenta.declarado} size={16} /> : <span className="text-cos-ink-faint">—</span>}
                    </div>
                  </div>

                  {/* Documentos derivados */}
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-cos-ink-faint">
                      Documentos derivados
                    </p>
                    {docsCargando ? (
                      <p className="mt-2 flex items-center gap-2 text-cos-ink-soft">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando…
                      </p>
                    ) : docs && docs.documentos.length > 0 ? (
                      <ul className="mt-1.5 divide-y divide-cos-line-soft">
                        {docs.documentos.map((d) => (
                          <li key={d.id} className="flex items-baseline justify-between gap-2 py-1.5">
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-cos-ink">
                                {d.invoice?.contraparte ?? d.descripcion}
                              </span>
                              <span className="font-mono text-[11px] text-cos-ink-faint">
                                {d.invoice
                                  ? `${d.invoice.uuid.slice(0, 4)}…${d.invoice.uuid.slice(-4)}`
                                  : d.fuente}
                                {" · "}
                                {new Date(d.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}
                              </span>
                            </span>
                            <Money value={d.monto} className="text-[13px]" />
                          </li>
                        ))}
                        {docs.total > docs.mostrados && (
                          <li className="py-1.5 text-[12px] text-cos-ink-faint">
                            + {docs.total - docs.mostrados} más
                          </li>
                        )}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[13px] text-cos-ink-soft">Sin asientos derivados en el período.</p>
                    )}
                  </div>

                  {presentado && (
                    <>
                      <div className="flex items-center justify-between rounded-md bg-cos-red-tint px-3 py-2">
                        <span className="text-[13px] font-medium text-cos-red-ink">Diferencia a adoptar</span>
                        <Money value={sel.cuenta.diferencia} size={16} className="text-cos-red-ink" />
                      </div>

                      {/* Adopción: v1 sólo la acción con backend real. La cola de
                          overrides (PostingCuentaOverride) llega con el módulo 4. */}
                      <Link
                        href={`/contabilidad/ajustes?cuenta=${encodeURIComponent(sel.cuenta.numCta)}&monto=${Math.abs(sel.cuenta.diferencia).toFixed(2)}&concepto=${encodeURIComponent(`Ajuste por divergencia CE — ${sel.cuenta.numCta} ${label}`)}`}
                        className="flex items-center justify-between rounded-control border border-cos-line px-3 py-2.5 text-left hover:bg-cos-paper"
                      >
                        <span>
                          <span className="block text-[13px] font-semibold text-cos-ink">Crear póliza de ajuste</span>
                          <span className="block text-[12px] text-cos-ink-soft">
                            genera una póliza MANUAL por <Money value={Math.abs(sel.cuenta.diferencia)} className="mx-0.5 text-[12px]" muted />
                          </span>
                        </span>
                        <ArrowRight className="h-4 w-4 shrink-0 text-cos-ink-faint" />
                      </Link>
                    </>
                  )}

                  <p className="flex items-center gap-1.5 border-t border-cos-line-soft pt-3 text-[12px] text-cos-ink-faint">
                    <Target className="h-3.5 w-3.5" /> Meta: residuo <span className="font-mono">$0.00</span> sostenido
                  </p>
                </div>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Filas de un rubro (encabezado + cuentas) ─────────────────────────────────
function RubroFilas({
  rubro, sem, abierto, presentado, selCuenta, onToggle, onSelect, tdNum,
}: {
  rubro: Rubro;
  sem: Semaforo;
  abierto: boolean;
  presentado: boolean;
  selCuenta: string | null;
  onToggle: () => void;
  onSelect: (c: RenglonCuenta) => void;
  tdNum: string;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="h-[38px] cursor-pointer border-t border-cos-line-soft bg-cos-slate-tint font-semibold hover:brightness-[0.98]"
      >
        <td className="px-3 py-0">
          <span className="flex items-center gap-1">
            {abierto ? (
              <ChevronDown className="h-3.5 w-3.5 text-cos-ink-faint" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-cos-ink-faint" />
            )}
          </span>
        </td>
        <td className="px-3 py-0 uppercase">{rubro.titulo}</td>
        <td className="px-3 py-0">{presentado && <ChipSemaforo s={sem} />}</td>
        <td className={tdNum}><Money value={rubro.derivado} /></td>
        {presentado && <td className={tdNum}><Money value={rubro.declarado} /></td>}
        {presentado && (
          <td className={tdNum}>
            <Money
              value={rubro.diferencia}
              className={Math.abs(rubro.diferencia) >= 0.005 ? "text-cos-red-ink" : undefined}
            />
          </td>
        )}
      </tr>
      {abierto &&
        rubro.cuentas.map((c) => {
          const semC = semaforoDe(c.diferencia, rubro);
          const seleccionada = selCuenta === c.numCta;
          const conDif = Math.abs(c.diferencia) >= 0.005;
          return (
            <tr
              key={c.numCta}
              onClick={() => onSelect(c)}
              className={cn(
                "cursor-pointer border-t border-cos-line-soft",
                conDif ? "h-[46px]" : "h-[38px]",
                seleccionada
                  ? "bg-cos-brand-tint shadow-[inset_3px_0_0_var(--brand)]"
                  : "hover:bg-cos-paper"
              )}
            >
              <td className="py-0 pl-8 pr-3 font-mono text-cos-ink-soft">{c.numCta}</td>
              <td className="max-w-[230px] truncate px-3 py-0">{c.nombre || "(sin nombre)"}</td>
              <td className="px-3 py-0">{presentado && <ChipSemaforo s={semC.s} />}</td>
              <td className={tdNum}><Money value={c.derivado} /></td>
              {presentado && <td className={tdNum}><Money value={c.declarado} /></td>}
              {presentado && (
                <td className={tdNum}>
                  <Money value={c.diferencia} className={conDif ? "text-cos-red-ink" : undefined} />
                  {conDif && semC.pct > 0 && (
                    <span className="block text-[11px] font-normal text-cos-ink-faint">
                      {(semC.pct * 100).toFixed(1)}% del rubro
                    </span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
    </>
  );
}
