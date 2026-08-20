"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Presentado (CE): los estados financieros LEÍDOS de la balanza presentada al
// SAT (CeBalanzaMes) — lo que el contador declaró, no lo que el motor derivó.
//
// La balanza de MARGOM trae el LADO en el signo (convencionQueCuadra): las
// cuentas acreedoras vienen negativas. Eso da dos regalos: la utilidad
// acumulada es −Σ saldoFin(4xxx–9xxx), y Σ saldoFin de TODAS las hojas ≈ 0 es
// un checksum de la propia balanza.
//
// Granularidad: cada renglón se expande a su SERIE mensual completa (todos los
// períodos presentados). La capa de evidencia CFDI por cuenta-mes es la fase
// siguiente (necesita el mapeo CFDI → cuenta del catálogo del contador).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface Periodo { anio: number; mes: number }
interface CuentaMes {
  numCta: string;
  nombre: string | null;
  saldoIni: number;
  debe: number;
  haber: number;
  saldoFin: number;
}
interface SerieMes { anio: number; mes: number; saldoIni: number; debe: number; haber: number; saldoFin: number }

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Primer dígito del código → grupo del estado financiero. */
function grupoDe(numCta: string): "activo" | "pasivo" | "capital" | "resultados" {
  const d = numCta[0];
  if (d === "1") return "activo";
  if (d === "2") return "pasivo";
  if (d === "3") return "capital";
  return "resultados"; // 4 ingresos, 5 costos, 6 gastos, 7–9 otros
}

export function CePresentadoPanel({ companyId }: { companyId: string }) {
  const [periodos, setPeriodos] = useState<Periodo[]>([]);
  const [sel, setSel] = useState<Periodo | null>(null);
  const [cuentas, setCuentas] = useState<CuentaMes[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [vista, setVista] = useState<"resultados" | "balance">("resultados");

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/contabilidad/ce-serie?companyId=${companyId}&periodos=1`);
      const data = res.ok ? await res.json() : { periodos: [] };
      setPeriodos(data.periodos);
      setSel(data.periodos.at(-1) ?? null);
      if (data.periodos.length === 0) setLoading(false);
    })();
  }, [companyId]);

  useEffect(() => {
    if (!sel) return;
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/ce-serie?companyId=${companyId}&anio=${sel.anio}&mes=${sel.mes}`);
      setCuentas(res.ok ? (await res.json()).cuentas : null);
      setLoading(false);
    })();
  }, [companyId, sel]);

  const resumen = useMemo(() => {
    if (!cuentas) return null;
    const suma = (filtro: (c: CuentaMes) => boolean, campo: (c: CuentaMes) => number) =>
      cuentas.filter(filtro).reduce((s, c) => s + campo(c), 0);
    const activo = suma((c) => grupoDe(c.numCta) === "activo", (c) => c.saldoFin);
    const pasivo = -suma((c) => grupoDe(c.numCta) === "pasivo", (c) => c.saldoFin);
    const capital = -suma((c) => grupoDe(c.numCta) === "capital", (c) => c.saldoFin);
    const utilidadAcum = -suma((c) => grupoDe(c.numCta) === "resultados", (c) => c.saldoFin);
    const checksum = suma(() => true, (c) => c.saldoFin);
    return { activo, pasivo, capital, utilidadAcum, checksum };
  }, [cuentas]);

  if (periodos.length === 0 && !loading) {
    return (
      <p className="text-sm text-cos-ink-soft">
        Sin balanzas presentadas importadas. Corre la importación de la serie CE
        (Syntage → CeBalanzaMes) para leer aquí lo declarado.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <select
          value={sel ? `${sel.anio}-${sel.mes}` : ""}
          onChange={(e) => {
            const [a, m] = e.target.value.split("-").map(Number);
            setSel({ anio: a, mes: m });
          }}
          className="rounded-lg border border-cos-line bg-white px-3 py-1.5 text-sm"
        >
          {periodos.map((p) => (
            <option key={`${p.anio}-${p.mes}`} value={`${p.anio}-${p.mes}`}>
              {MESES[p.mes]} {p.anio}
            </option>
          ))}
        </select>
        <div className="flex rounded-lg border border-cos-line overflow-hidden text-sm">
          {(["resultados", "balance"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setVista(v)}
              className={`px-3 py-1.5 ${vista === v ? "bg-cos-brand text-white" : "bg-white text-cos-ink-soft hover:text-cos-ink"}`}
            >
              {v === "resultados" ? "Estado de resultados" : "Balance general"}
            </button>
          ))}
        </div>
        <span className="text-xs text-cos-ink-soft">
          Leído de la balanza presentada al SAT — no del motor de posteo.
        </span>
      </div>

      {/* En papel, el período y la vista viven en el select y el toggle de
          arriba (ocultos al imprimir); esta línea los repone como hechos. */}
      <p className="hidden print:block mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-cos-ink-soft">
        {sel ? `${MESES[sel.mes]} ${sel.anio}` : ""}
        {" · "}
        {vista === "resultados" ? "Estado de resultados" : "Balance general"}
        {" · leído de la balanza presentada al SAT"}
      </p>

      {loading || !cuentas || !resumen ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando balanza presentada…
        </div>
      ) : (
        <>
          <Checksum resumen={resumen} />
          {vista === "resultados" ? (
            <EstadoResultadosCE cuentas={cuentas} companyId={companyId} utilidadAcum={resumen.utilidadAcum} />
          ) : (
            <BalanceCE cuentas={cuentas} companyId={companyId} resumen={resumen} />
          )}
        </>
      )}
    </div>
  );
}

function Checksum({ resumen }: { resumen: { activo: number; pasivo: number; capital: number; utilidadAcum: number; checksum: number } }) {
  const cuadra = Math.abs(resumen.checksum) < 1;
  return (
    <div
      className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
        cuadra
          ? "border-cos-jade-ink/25 bg-cos-jade-tint text-cos-jade-ink"
          : "border-cos-amber-ink/25 bg-cos-amber-tint text-cos-amber-ink"
      }`}
    >
      {cuadra ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
      {cuadra
        ? `La balanza presentada cuadra: Activo ${formatCurrency(resumen.activo)} = Pasivo ${formatCurrency(resumen.pasivo)} + Capital ${formatCurrency(resumen.capital)} + Resultado ${formatCurrency(resumen.utilidadAcum)}.`
        : `La balanza presentada NO cuadra por ${formatCurrency(Math.abs(resumen.checksum))} — así se declaró; no es un error nuestro.`}
    </div>
  );
}

/** Renglón expandible: al abrirse trae su serie mensual completa. */
function FilaCuenta({
  c,
  companyId,
  monto,
  montoMes,
}: {
  c: CuentaMes;
  companyId: string;
  monto: number;
  montoMes?: number;
}) {
  const [abierta, setAbierta] = useState(false);
  const [serie, setSerie] = useState<SerieMes[] | null>(null);

  const toggle = useCallback(async () => {
    setAbierta((a) => !a);
    if (!serie) {
      const res = await fetch(`/api/contabilidad/ce-serie?companyId=${companyId}&cuenta=${encodeURIComponent(c.numCta)}`);
      setSerie(res.ok ? (await res.json()).serie : []);
    }
  }, [serie, companyId, c.numCta]);

  return (
    <>
      <tr className="border-b border-cos-line/60 hover:bg-cos-paper cursor-pointer" onClick={toggle}>
        <td className="py-1.5 pr-2 w-5 text-cos-ink-soft">
          {abierta ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="py-1.5 pr-3 font-mono text-xs text-cos-ink-soft whitespace-nowrap">{c.numCta}</td>
        <td className="py-1.5 pr-3">{c.nombre ?? <span className="text-cos-ink-soft italic">sin nombre en catálogo</span>}</td>
        {montoMes !== undefined && <td className="py-1.5 pr-3 text-right tabular-nums">{formatCurrency(montoMes)}</td>}
        <td className="py-1.5 text-right tabular-nums font-medium">{formatCurrency(monto)}</td>
      </tr>
      {abierta && (
        <tr className="border-b border-cos-line/60 bg-cos-paper/60">
          <td colSpan={montoMes !== undefined ? 5 : 4} className="py-2 pl-8 pr-3">
            {!serie ? (
              <span className="flex items-center gap-2 text-xs text-cos-ink-soft">
                <Loader2 className="h-3 w-3 animate-spin" /> Cargando serie…
              </span>
            ) : (
              <table className="text-xs w-full max-w-2xl">
                <thead>
                  <tr className="text-cos-ink-soft">
                    <th className="text-left font-normal pb-1">período</th>
                    <th className="text-right font-normal pb-1">saldo inicial</th>
                    <th className="text-right font-normal pb-1">debe</th>
                    <th className="text-right font-normal pb-1">haber</th>
                    <th className="text-right font-normal pb-1">saldo final</th>
                  </tr>
                </thead>
                <tbody>
                  {serie.map((s) => (
                    <tr key={`${s.anio}-${s.mes}`} className="border-t border-cos-line/40">
                      <td className="py-0.5">{MESES[s.mes]} {s.anio}</td>
                      <td className="py-0.5 text-right tabular-nums">{formatCurrency(s.saldoIni)}</td>
                      <td className="py-0.5 text-right tabular-nums">{formatCurrency(s.debe)}</td>
                      <td className="py-0.5 text-right tabular-nums">{formatCurrency(s.haber)}</td>
                      <td className="py-0.5 text-right tabular-nums">{formatCurrency(s.saldoFin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Bloque({
  titulo,
  filas,
  total,
  companyId,
  conMes,
  monto,
  montoMes,
}: {
  titulo: string;
  filas: CuentaMes[];
  total: number;
  companyId: string;
  conMes?: boolean;
  monto: (c: CuentaMes) => number;
  montoMes?: (c: CuentaMes) => number;
}) {
  if (filas.length === 0) return null;
  return (
    <div className="mb-5">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-cos-ink-soft border-b border-cos-line">
            <th className="w-5" />
            <th className="text-left font-medium pb-1.5" colSpan={2}>{titulo}</th>
            {conMes && <th className="text-right font-medium pb-1.5">mes</th>}
            <th className="text-right font-medium pb-1.5">acumulado</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((c) => (
            <FilaCuenta
              key={c.numCta}
              c={c}
              companyId={companyId}
              monto={monto(c)}
              montoMes={conMes && montoMes ? montoMes(c) : undefined}
            />
          ))}
          <tr className="font-semibold">
            <td />
            <td colSpan={2} className="py-2">Total {titulo.toLowerCase()}</td>
            {conMes && <td />}
            <td className="py-2 text-right tabular-nums">{formatCurrency(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function EstadoResultadosCE({
  cuentas,
  companyId,
  utilidadAcum,
}: {
  cuentas: CuentaMes[];
  companyId: string;
  utilidadAcum: number;
}) {
  const resultados = cuentas.filter((c) => grupoDe(c.numCta) === "resultados");
  const conMovimiento = resultados.filter(
    (c) => Math.abs(c.saldoFin) >= 0.01 || Math.abs(c.debe) + Math.abs(c.haber) >= 0.01,
  );
  const por = (d: string) => conMovimiento.filter((c) => c.numCta[0] === d);
  const ingresos = por("4");
  const costos = por("5");
  const gastos = por("6");
  const otros = conMovimiento.filter((c) => Number(c.numCta[0]) >= 7);

  // Acreedoras (ingresos) al derecho: −saldoFin; deudoras tal cual. En el MES,
  // ingresos = haber − debe y deudoras = debe − haber.
  const acum = (c: CuentaMes, acreedora: boolean) => (acreedora ? -c.saldoFin : c.saldoFin);
  const mesN = (c: CuentaMes, acreedora: boolean) => (acreedora ? c.haber - c.debe : c.debe - c.haber);
  const tot = (fs: CuentaMes[], acreedora: boolean) => fs.reduce((s, c) => s + acum(c, acreedora), 0);
  const totMes = (fs: CuentaMes[], acreedora: boolean) => fs.reduce((s, c) => s + mesN(c, acreedora), 0);
  const utilidadMes = totMes(ingresos, true) - totMes(costos, false) - totMes(gastos, false) - totMes(otros, false);

  return (
    <div>
      <Bloque titulo="Ingresos" filas={ingresos} total={tot(ingresos, true)} companyId={companyId} conMes monto={(c) => acum(c, true)} montoMes={(c) => mesN(c, true)} />
      <Bloque titulo="Costos" filas={costos} total={tot(costos, false)} companyId={companyId} conMes monto={(c) => acum(c, false)} montoMes={(c) => mesN(c, false)} />
      <Bloque titulo="Gastos" filas={gastos} total={tot(gastos, false)} companyId={companyId} conMes monto={(c) => acum(c, false)} montoMes={(c) => mesN(c, false)} />
      <Bloque titulo="Otros resultados (7–9)" filas={otros} total={tot(otros, false)} companyId={companyId} conMes monto={(c) => acum(c, false)} montoMes={(c) => mesN(c, false)} />
      <div className="flex justify-between border-t-2 border-cos-ink pt-2 text-sm font-semibold">
        <span>Utilidad del período · acumulada del ejercicio</span>
        <span className="tabular-nums">
          {formatCurrency(utilidadMes)} · {formatCurrency(utilidadAcum)}
        </span>
      </div>
    </div>
  );
}

function BalanceCE({
  cuentas,
  companyId,
  resumen,
}: {
  cuentas: CuentaMes[];
  companyId: string;
  resumen: { activo: number; pasivo: number; capital: number; utilidadAcum: number };
}) {
  const con = (g: string) =>
    cuentas.filter((c) => grupoDe(c.numCta) === g && Math.abs(c.saldoFin) >= 0.01);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
      <Bloque titulo="Activo" filas={con("activo")} total={resumen.activo} companyId={companyId} monto={(c) => c.saldoFin} />
      <div>
        <Bloque titulo="Pasivo" filas={con("pasivo")} total={resumen.pasivo} companyId={companyId} monto={(c) => -c.saldoFin} />
        <Bloque titulo="Capital contable" filas={con("capital")} total={resumen.capital} companyId={companyId} monto={(c) => -c.saldoFin} />
        <div className="flex justify-between border-t-2 border-cos-ink pt-2 text-sm font-semibold">
          <span>Resultado del ejercicio (acumulado)</span>
          <span className="tabular-nums">{formatCurrency(resumen.utilidadAcum)}</span>
        </div>
      </div>
    </div>
  );
}
