"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /bancos — LA MESA AL FRENTE.
//
// Todos los CTAs del producto («Ir a Bancos», «Clasificar en Bancos», los del
// tablero) mandan aquí, pero la mesa de conciliación split-view vivía en
// /contabilidad/conciliacion, a donde sólo llegaba quien navegara el flujo de
// cierre. El producto prometía la mesa y entregaba el monolito de 1,798
// líneas. Ahora /bancos abre con la mesa (ConciliacionWorkbench, el MISMO
// componente — no una copia) y el resto del monolito vive en tabs:
//
//   Conciliación  la mesa: banco ↔ CFDIs cuadrando a cero   (default)
//   Movimientos   el archivo: todos los meses de corrido, con el detalle del
//                 cruce, las devoluciones y las comisiones
//   Cuentas       alta/edición, importar estados, deshacer lotes
//   Histórico     qué se casó con qué, con Desconciliar a la mano
//
// EL REPARTO: la mesa DECIDE (conciliar, categorizar, en lote), el archivo
// BUSCA Y MUESTRA. El triage estaba en los dos y por eso seguían sintiéndose
// dos mesas; ahora el archivo entrega el movimiento con «Resolver en la mesa»
// —un callback a esta página (resolverEnLaMesa), NO un enlace: el archivo vive
// en un tab de esta misma ruta y un <Link> a /bancos?tx= no la remonta— y la
// URL sólo lo refleja (?year=&month=&tx=), para que el deep link siga sirviendo.
//
// Deep links: ?tab=movimientos|cuentas|historico (sin ?tab = la mesa);
// ?year=&month=&tx= abre la mesa en ese mes con ese movimiento elegido.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { Loading } from "@/components/ui/feedback";
import { ConciliacionWorkbench } from "@/components/contabilidad/ConciliacionWorkbench";
import { ExpedienteEnContexto } from "@/components/expediente/ExpedienteEnContexto";
import { BankStatementReview } from "@/components/bancos/BankStatementReview";
import { GestionBancos } from "@/components/bancos/GestionBancos";
import { CuentasDelCatalogo } from "@/components/bancos/CuentasDelCatalogo";
import { readBankLocation, type BankTab as Tab } from "@/lib/bancos/navigation";
import { TopTabsBar } from "@/components/layout/TopTabsBar";
import { SelectorPeriodo } from "@/components/ui/SelectorPeriodo";
import { ultimosEjercicios } from "@/lib/periodos";

const TABS: { id: Tab; label: string }[] = [
  { id: "conciliacion", label: "Conciliación" },
  { id: "estados", label: "Estados y duplicados" },
  { id: "movimientos", label: "Movimientos" },
  { id: "cuentas", label: "Cuentas" },
  { id: "historico", label: "Histórico" },
];

export default function BancosPage() {
  return <Suspense fallback={<Loading className="p-8" />}><BancosContent /></Suspense>;
}

function BancosContent() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const location = useMemo(() => readBankLocation(query), [query]);
  const { tab, tx: txInicial } = location;
  // EL PERÍODO ES EL DE LA APP, no uno propio: se elige una vez y sigue igual
  // al saltar entre Bancos y el cierre. Antes cada pantalla arrancaba en el mes
  // corriente y había que volver a agosto en cada pestaña.
  const { year, month, setPeriod } = usePeriod();
  // Next keeps this page mounted for same-route chat links. Follow every URL
  // change, including back/forward, instead of reading it only on first mount.
  const linkedYear = location.period?.year, linkedMonth = location.period?.month;
  useEffect(() => {
    if (linkedYear && linkedMonth && (year !== linkedYear || month !== linkedMonth)) setPeriod(linkedYear, linkedMonth);
  }, [linkedYear, linkedMonth, year, month, setPeriod]);
  // Remonta el tab activo tras conciliar en la mesa, para que las listas
  // (movimientos/histórico) relean al volver.
  const [version, setVersion] = useState(0);

  function irA(t: Tab) {
    const url = t === "conciliacion" ? "/bancos" : `/bancos?tab=${t}`;
    window.history.replaceState(null, "", url);
  }
  function irAlPeriodo(y: number, m: number) {
    setPeriod(y, m);
    // Cambiar de mes deja atrás el movimiento entregado: su `?tx=` en la barra
    // de direcciones prometería una selección que ya no existe.
    if (location.period || txInicial) window.history.replaceState(null, "", tab === "estados" ? "/bancos?tab=estados" : "/bancos");
  }
  // ENTREGA DESDE EL ARCHIVO. El tab Movimientos vive en ESTA misma página, así
  // que no hace falta recargar la página. La URL es la fuente de tab/selección
  // tanto para este callback como para los enlaces del copiloto.
  function resolverEnLaMesa(tx: { id: string; fecha: string }) {
    const [y, m] = tx.fecha.slice(0, 7).split("-").map(Number);
    if (!Number.isInteger(y) || !Number.isInteger(m)) return;
    setPeriod(y, m);
    window.history.replaceState(null, "", `/bancos?year=${y}&month=${m}&tx=${encodeURIComponent(tx.id)}`);
  }
  function moverPeriodo(delta: number) {
    const idx = year * 12 + (month - 1) + delta;
    irAlPeriodo(Math.floor(idx / 12), (idx % 12) + 1);
  }

  if (!activeCompany) {
    // Mientras el CompanyProvider carga aún no se sabe qué empresa está
    // activa: pintar "Selecciona una empresa." aquí era un destello falso en
    // cada entrada a la página.
    if (companyLoading) return <Loading className="p-8" />;
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  return (
    <div>
      <TopTabsBar
        ariaLabel="Secciones de Bancos"
        innerClassName="max-w-[1060px]"
        tabs={TABS.map(({ id, label }) => ({ key: id, label, active: tab === id, onSelect: () => irA(id) }))}
      />
      <div className="mx-auto max-w-[1060px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Bancos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">
            {tab === "movimientos"
              ? "El archivo de tus cuentas: todos los meses de corrido. El trabajo del período se hace en Conciliación."
              : "Conectamos los movimientos de tu banco con tus facturas para que todo cuadre."}
          </p>
        </div>
        {/* El período manda sobre la mesa; Movimientos/Histórico traen su
            propio corte por mes dentro de su barra de filtros. */}
        {/* El MISMO selector que Facturas y el archivo: una sola gramática para
            elegir un mes en toda la aplicación. Las flechas se quedan porque
            el gesto de la mesa es mes±1; la rejilla es para saltar a marzo del
            año pasado sin doce clics. Sin cifras: el feed de la mesa es de UN
            mes y no sabe cuántos movimientos tienen los demás. */}
        {(tab === "conciliacion" || tab === "estados") && (
          <div className="flex items-center gap-1">
            <button onClick={() => moverPeriodo(-1)} aria-label="Período anterior"
              className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <SelectorPeriodo
              className="min-w-[190px]"
              valor={`${year}-${String(month).padStart(2, "0")}`}
              anios={ultimosEjercicios(Math.max(year, new Date().getFullYear()))}
              permitirTodo={false}
              permitirEjercicio={false}
              sustantivo="movimientos"
              onChange={(v) => {
                const [y, m] = v.split("-").map(Number);
                irAlPeriodo(y, m);
              }}
            />
            <button onClick={() => moverPeriodo(1)} aria-label="Período siguiente"
              className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-5">
        {tab === "conciliacion" && (
          // En la mesa, no en Movimientos: lo que no vive en la mesa no se usa.
          <ExpedienteEnContexto
            companyId={activeCompany.id}
            className="mb-4"
            titulo="Lo que sabemos de sus terminales y cuentas"
            familias={["terminal", "banco"]}
            temas={["conciliacion"]}
            claves={["terminal.afiliacion", "terminal.adquirente", "banco.cuenta"]}
            vacio="Nada anotado. Con la terminal y su afiliación escritas, la conciliación sabe qué estado de cuenta pedir."
          />
        )}
        {tab === "conciliacion" ? (
          <ConciliacionWorkbench
            companyId={activeCompany.id}
            year={year}
            month={month}
            txInicial={txInicial}
            onApplied={() => setVersion((v) => v + 1)}
          />
        ) : tab === "estados" ? (
          <BankStatementReview key={`${activeCompany.id}-${year}-${month}`} companyId={activeCompany.id} year={year} month={month} />
        ) : (
          <>
            <CuentasDelCatalogo companyId={activeCompany.id} className="mb-4" onRegistradas={() => setVersion((v) => v + 1)} />
            <GestionBancos key={`${tab}-${version}`} vista={tab} onResolverEnLaMesa={resolverEnLaMesa} />
          </>
        )}
      </div>
      </div>
    </div>
  );
}
