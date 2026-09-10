"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import {
  MESES_CORTOS,
  PERIODO_TODO,
  agruparPorEjercicio,
  ejerciciosSinConteo,
  etiquetaPeriodo,
  totalComprobantes,
  type ConteoPeriodo,
} from "@/lib/periodos";

// ─────────────────────────────────────────────────────────────────────────────
// Selector de periodo de la pantalla de Facturas.
//
// La primera versión era un <select> nativo con una opción por mes: con cuatro
// ejercicios de historia eso son más de cincuenta renglones que hay que
// recorrer con la rueda del ratón, y el desplegable lo pinta el sistema
// operativo, así que ni siquiera respeta el tema de la app.
//
// Esto usa el MISMO lenguaje que la rejilla de «Cierres mensuales» en
// Contabilidad: eliges ejercicio y luego el mes en una cuadrícula de 12 celdas
// con posiciones fijas. Los meses sin comprobantes se pintan apagados en vez de
// esconderse — que agosto esté vacío es información, y mantener a julio siempre
// en el mismo lugar es lo que hace la rejilla escaneable de un vistazo.
//
// DOS MODOS, porque no toda pantalla sabe contar. Con `conteos` es lo de
// arriba. SIN ellos (`anios`), la rejilla ofrece esos ejercicios completos, sin
// cifras y con los doce meses disponibles: la mesa de conciliación trabaja UN
// mes y su feed no sabe cuántos movimientos tienen los demás — pero saltar a
// cualquiera es justamente lo que hacía falta, y pintar todo en cero sería
// afirmar un dato que nadie midió.
//
// Vive en components/ui y no en components/facturas porque la usan Facturas,
// el archivo de Bancos y la mesa: un selector de periodo por pantalla es cómo
// se acaba con tres gramáticas distintas para elegir un mes.
// ─────────────────────────────────────────────────────────────────────────────

export function SelectorPeriodo({
  valor,
  conteos,
  anios,
  onChange,
  permitirTodo = true,
  permitirEjercicio = true,
  sustantivo = "comprobantes",
  className,
}: {
  /** "todo" | "YYYY" | "YYYY-MM" */
  valor: string;
  /** Conteo por mes. Omitido = la rejilla no enseña cifras y no apaga meses. */
  conteos?: ConteoPeriodo[];
  /** Ejercicios a ofrecer cuando no hay conteos que los revelen. */
  anios?: number[];
  onChange: (valor: string) => void;
  /** «Todo el historial»: el archivo lo quiere; una pantalla que trabaja un
   *  mes (la mesa) no puede honrarlo. */
  permitirTodo?: boolean;
  /** «Todo 2026», por la misma razón. */
  permitirEjercicio?: boolean;
  /** Qué se cuenta, para que los títulos digan la verdad. */
  sustantivo?: string;
  className?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const contenedor = useRef<HTMLDivElement | null>(null);

  const sinConteos = conteos === undefined;
  const ejercicios = sinConteos
    ? ejerciciosSinConteo(anios ?? [new Date().getFullYear()])
    : agruparPorEjercicio(conteos);
  const total = sinConteos ? 0 : totalComprobantes(conteos);

  // Ejercicio que se está mostrando en la rejilla. Arranca en el del periodo
  // elegido; si es "todo el historial", en el más reciente con datos.
  const anioDelValor = /^(\d{4})/.exec(valor)?.[1];
  const [anioVista, setAnioVista] = useState<number | null>(null);
  const anioActivo =
    anioVista ?? (anioDelValor ? Number(anioDelValor) : ejercicios[0]?.anio ?? null);
  const ejercicio = ejercicios.find((e) => e.anio === anioActivo) ?? ejercicios[0] ?? null;

  useEffect(() => {
    if (!abierto) return;
    function fuera(e: MouseEvent) {
      if (contenedor.current && !contenedor.current.contains(e.target as Node)) setAbierto(false);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setAbierto(false);
    }
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto]);

  function elegir(v: string) {
    onChange(v);
    setAbierto(false);
  }

  // Etiqueta del botón: el periodo elegido y cuántos comprobantes tiene.
  const conteoDelValor = sinConteos
    ? 0
    : valor === PERIODO_TODO
      ? total
      : /^\d{4}$/.test(valor)
      ? ejercicios.find((e) => e.anio === Number(valor))?.total ?? 0
      : ejercicios.flatMap((e) => e.meses).find((m) => m.periodo === valor)?.total ?? 0;

  return (
    <div ref={contenedor} className={`relative${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        onClick={() => setAbierto((o) => !o)}
        aria-expanded={abierto}
        aria-haspopup="dialog"
        className="flex h-full w-full items-center gap-2 rounded-control border border-cos-line bg-cos-card px-3.5 py-3 text-left text-[14.5px] text-cos-ink outline-none hover:bg-cos-paper focus-visible:ring-1 focus-visible:ring-cos-brand"
      >
        <CalendarRange className="h-[18px] w-[18px] shrink-0 text-cos-ink-faint" />
        <span className="font-medium">{etiquetaPeriodo(valor)}</span>
        {!sinConteos && (
          <span className="font-mono text-[12px] text-cos-ink-faint">{conteoDelValor.toLocaleString("es-MX")}</span>
        )}
        <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-cos-ink-faint transition-transform ${abierto ? "rotate-180" : ""}`} />
      </button>

      {abierto && (
        <div
          role="dialog"
          aria-label="Elegir periodo"
          className="absolute right-0 z-50 mt-1.5 w-[320px] rounded-card border border-cos-line bg-cos-card p-3 shadow-[0_20px_45px_-15px_oklch(0.2_0.05_258_/_0.45)]"
        >
          {/* Todo el historial */}
          {permitirTodo && (
          <button
            type="button"
            onClick={() => elegir(PERIODO_TODO)}
            className={`flex w-full items-center justify-between rounded-control px-2.5 py-2 text-[13.5px] font-medium ${
              valor === PERIODO_TODO ? "bg-cos-brand text-white" : "text-cos-ink hover:bg-cos-paper"
            }`}
          >
            <span className="flex items-center gap-1.5">
              {valor === PERIODO_TODO && <Check className="h-3.5 w-3.5" />}
              Todo el historial
            </span>
            <span className="font-mono text-[12px] opacity-80">{total.toLocaleString("es-MX")}</span>
          </button>
          )}

          {ejercicios.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-[13px] text-cos-ink-faint">
              Todavía no hay {sustantivo}.
            </p>
          ) : (
            <>
              {/* Ejercicios */}
              <div className={`flex flex-wrap gap-1.5 ${permitirTodo ? "mt-2.5 border-t border-cos-line-soft pt-2.5" : ""}`}>
                {ejercicios.map((e) => {
                  const enVista = e.anio === ejercicio?.anio;
                  return (
                    <button
                      key={e.anio}
                      type="button"
                      onClick={() => setAnioVista(e.anio)}
                      title={sinConteos ? String(e.anio) : `${e.total.toLocaleString("es-MX")} ${sustantivo} en ${e.anio}`}
                      className={`rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                        enVista
                          ? "bg-cos-slate-tint text-cos-ink"
                          : "text-cos-ink-soft hover:bg-cos-paper"
                      }`}
                    >
                      {e.anio}
                    </button>
                  );
                })}
              </div>

              {ejercicio && (
                <>
                  {/* Ejercicio completo */}
                  {permitirEjercicio && (
                  <button
                    type="button"
                    onClick={() => elegir(String(ejercicio.anio))}
                    className={`mt-1.5 flex w-full items-center justify-between rounded-control px-2.5 py-1.5 text-[13px] font-medium ${
                      valor === String(ejercicio.anio)
                        ? "bg-cos-brand text-white"
                        : "text-cos-ink-soft hover:bg-cos-paper"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {valor === String(ejercicio.anio) && <Check className="h-3.5 w-3.5" />}
                      Todo {ejercicio.anio}
                    </span>
                    <span className="font-mono text-[12px] opacity-80">
                      {ejercicio.total.toLocaleString("es-MX")}
                    </span>
                  </button>
                  )}

                  {/* Rejilla de 12 meses, posiciones fijas */}
                  <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                    {ejercicio.meses.map((m) => {
                      const vacio = !sinConteos && m.total === 0;
                      const activo = valor === m.periodo;
                      return (
                        <button
                          key={m.periodo}
                          type="button"
                          disabled={vacio}
                          onClick={() => elegir(m.periodo)}
                          title={
                            sinConteos
                              ? etiquetaPeriodo(m.periodo)
                              : vacio
                                ? `Sin ${sustantivo} en ${etiquetaPeriodo(m.periodo)}`
                                : `${m.total.toLocaleString("es-MX")} ${sustantivo} en ${etiquetaPeriodo(m.periodo)}`
                          }
                          className={`rounded-control border px-1 py-1.5 text-center transition-colors ${
                            activo
                              ? "border-cos-brand bg-cos-brand text-white"
                              : vacio
                              ? "cursor-default border-transparent text-cos-ink-faint opacity-45"
                              : "border-cos-line text-cos-ink hover:border-cos-brand hover:bg-cos-paper"
                          }`}
                        >
                          <span className="block text-[12.5px] font-medium capitalize">
                            {MESES_CORTOS[m.mes - 1]}
                          </span>
                          {!sinConteos && (
                            <span className="block font-mono text-[11px] opacity-75">
                              {vacio ? "—" : m.total.toLocaleString("es-MX")}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
