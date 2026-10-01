"use client";

// Las cuentas bancarias que la empresa declaró en su catálogo de cuentas (CE
// del SAT) y aún no están en Bancos: un clic las registra ya ligadas a su
// cuenta contable. Lo usan el alta (pantalla Bancos) y la pantalla Bancos.
// No pinta nada si no hay sugerencias.

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check } from "lucide-react";
import type { SugerenciaCuentaBancaria } from "@/lib/bancos/cuentas-del-catalogo";
import { cn } from "@/lib/utils";

interface Fila extends SugerenciaCuentaBancaria {
  elegida: boolean;
  numeroCampo: string;
  bancoCampo: string;
}

export function CuentasDelCatalogo({
  companyId,
  onRegistradas,
  className,
}: {
  companyId: string;
  onRegistradas?: (n: number) => void;
  className?: string;
}) {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [periodo, setPeriodo] = useState<{ anio: number; mes: number } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [hechas, setHechas] = useState(0);
  const [errores, setErrores] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    const r = await fetch(`/api/bancos/sugeridas?companyId=${encodeURIComponent(companyId)}`).catch(() => null);
    if (!r?.ok) return setFilas([]);
    const j = (await r.json()) as { sugeridas: SugerenciaCuentaBancaria[]; catalogo: { anio: number; mes: number } | null };
    setPeriodo(j.catalogo);
    setFilas(j.sugeridas.map((s) => ({ ...s, elegida: !!s.numero, numeroCampo: s.numero ?? "", bancoCampo: s.banco ?? "" })));
  }, [companyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!filas || (filas.length === 0 && hechas === 0)) return null;

  const elegidas = filas.filter((f) => f.elegida);
  const listas = elegidas.every((f) => f.numeroCampo.replace(/\D/g, "").length >= 4 && f.bancoCampo.trim());

  async function registrar() {
    setEnviando(true);
    setErrores([]);
    let n = 0;
    const errs: string[] = [];
    for (const f of elegidas) {
      const res = await fetch("/api/bancos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          banco: f.bancoCampo.trim(),
          nombre: f.nombre,
          numeroCuenta: f.numeroCampo.replace(/\s/g, ""),
          moneda: f.moneda,
          chartAccountId: f.chartAccountId,
        }),
      });
      if (res.ok) n++;
      else errs.push(`${f.nombre}: ${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "no se pudo"}`);
    }
    setHechas((h) => h + n);
    setErrores(errs);
    setEnviando(false);
    if (n > 0) onRegistradas?.(n);
    await cargar();
  }

  const cambiar = (id: string, cambio: Partial<Fila>) => setFilas((xs) => xs!.map((x) => (x.chartAccountId === id ? { ...x, ...cambio } : x)));

  return (
    <div className={cn("rounded-2xl border border-cos-brand/40 bg-cos-brand-tint/50 p-4", className)}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-cos-card text-cos-brand-ink">
          <BookOpen className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-cos-ink">
            {filas.length > 0
              ? `Encontré ${filas.length} ${filas.length === 1 ? "cuenta bancaria" : "cuentas bancarias"} en tu catálogo de cuentas`
              : "Registré las cuentas de tu catálogo"}
          </p>
          <p className="mt-0.5 text-xs text-cos-ink-soft">
            Las declaraste en tu contabilidad electrónica{periodo ? ` (catálogo de ${String(periodo.mes).padStart(2, "0")}/${periodo.anio})` : ""}. Se registran ya ligadas
            a su cuenta contable.
          </p>
        </div>
      </div>

      {filas.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {filas.map((f) => (
            <li key={f.chartAccountId} className="flex flex-wrap items-center gap-2 rounded-xl border border-cos-line bg-cos-card px-3 py-2.5">
              <input
                type="checkbox"
                aria-label={`Registrar ${f.nombre}`}
                checked={f.elegida}
                onChange={(e) => cambiar(f.chartAccountId, { elegida: e.target.checked })}
                className="h-4 w-4 accent-[var(--brand)]"
              />
              <div className="min-w-[160px] flex-1">
                <p className="text-sm font-medium text-cos-ink">{f.nombre}</p>
                <p className="font-mono text-[11px] text-cos-ink-faint">
                  {f.codigo} · {f.moneda}
                </p>
              </div>
              {f.elegida && (
                <>
                  <input
                    value={f.bancoCampo}
                    onChange={(e) => cambiar(f.chartAccountId, { bancoCampo: e.target.value })}
                    placeholder="Banco"
                    className="w-28 rounded-lg border border-cos-line bg-cos-paper px-2 py-1.5 text-sm"
                  />
                  <input
                    value={f.numeroCampo}
                    inputMode="numeric"
                    onChange={(e) => cambiar(f.chartAccountId, { numeroCampo: e.target.value })}
                    placeholder="Número de cuenta"
                    className="w-40 rounded-lg border border-cos-line bg-cos-paper px-2 py-1.5 font-mono text-sm"
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {errores.length > 0 && <p className="mt-2 text-xs text-cos-red-ink">{errores.join(" · ")}</p>}

      <div className="mt-3 flex items-center gap-3">
        {filas.length > 0 && (
          <button
            type="button"
            disabled={enviando || elegidas.length === 0 || !listas}
            onClick={() => void registrar()}
            className="rounded-xl bg-cos-brand px-3.5 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-40"
          >
            {enviando ? "Registrando…" : `Registrar ${elegidas.length} ${elegidas.length === 1 ? "cuenta" : "cuentas"}`}
          </button>
        )}
        {hechas > 0 && (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-cos-jade-ink">
            <Check className="h-4 w-4" strokeWidth={2.5} /> {hechas} registrada{hechas === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}
