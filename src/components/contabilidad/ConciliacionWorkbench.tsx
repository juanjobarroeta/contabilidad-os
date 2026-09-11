"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Mesa de conciliación split-view (idioma del deck People, p10): movimientos
// del banco a la izquierda, CFDIs del mismo sentido a la derecha, un depósito
// contra varias facturas cuadrando a cero. Todo sobre APIs existentes:
//
//   GET  /api/bancos/conciliacion            → el mes (movimientos sin conciliar)
//   GET  /api/bancos/[cuenta]/match?txId=    → candidatos puntuados + impuestos
//   PATCH /api/bancos/transactions/[txId]    → match / match-multiple /
//                                              match-impuesto (ConciliacionDetalle)
//   POST /api/bancos/[cuenta]/match          → motor de auto-conciliación
//
// Las porciones se asignan en el orden en que se palomean los CFDIs: cada uno
// toma el mínimo entre su saldo y lo que queda del movimiento. Quedar por
// debajo se permite (cobro parcial / comisión) — el backend lo devuelve como
// advertencia y aquí se muestra.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, CheckSquare, Landmark, Loader2, Sparkles, X } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { StatTile, StatStrip } from "@/components/ui";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { AccionesEnLote } from "@/components/bancos/AccionesEnLote";
import { AvisoRepSugerido } from "@/components/bancos/AvisoRepSugerido";
import { ResolverMovimiento, type RepSugerido } from "@/components/bancos/ResolverMovimiento";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import { evaluarCoberturaBancaria } from "@/lib/bancos/conciliacion";
import { cn } from "@/lib/utils";

// ── Tipos espejo de las APIs ──────────────────────────────────────────────────
interface AnticipoPendiente {
  id: string;
  direccion: "CLIENTE" | "PROVEEDOR";
  fecha: string;
  monto: number;
  cliente: string | null;
  rfc: string | null;
  descripcion: string;
  dias: number;
  severidad: "reciente" | "atencion" | "vencido";
}
interface ResumenAnticipos {
  total: number;
  porFacturar: number;
  porRecibir: number;
  monto: number;
  diasMaximo: number;
  vencidos: number;
  montoVencido: number;
  anticipos: AnticipoPendiente[];
}

interface Movimiento {
  id: string;
  fecha: string;
  descripcion: string;
  /** Firmado: + depósito, − retiro. */
  monto: number;
  cuentaBancariaId: string;
  /** status ≠ UNMATCHED (conciliado o clasificado). */
  conciliado?: boolean;
  /** ¿Llegó al libro? Los UNMATCHED no se postean. Un IGNORED cuenta como
   *  registrado: se categorizó y el cierre lo asienta con su tag. */
  registrado?: boolean;
  // Contraparte extraída de la descripción (spei-descripcion.ts + su barrido).
  // La misma regla que el tab Movimientos: cuando el banco nos dijo QUIÉN, ése
  // es el titular del renglón — no la sintaxis del banco.
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  conceptoPago?: string | null;
  contraparteClabe?: string | null;
  claveRastreo?: string | null;
  /** Crudo: `conciliado` junta MATCHED e IGNORED y ahí se pierde la diferencia
   *  entre «tiene factura» y «se categorizó sin factura». */
  status?: "UNMATCHED" | "MATCHED" | "IGNORED";
  notes?: string | null;
}
interface Cuenta {
  bankAccountId: string;
  etiqueta: string;
}
/** GET /api/bancos — sólo lo que el encabezado de contexto usa. */
interface CuentaDetalle {
  id: string;
  banco: string;
  numeroCuenta: string;
  lastTransaction: { fecha: string; saldo: number | null } | null;
  stats: { total: number };
}
interface ConciliacionMes {
  /** TODOS los movimientos del mes (el feed ya manda el objeto completo); la
   *  cuenta permite calcular el % conciliado POR CUENTA sin otra consulta. */
  movimientosBanco: Movimiento[];
  movimientosNoRegistrados: Movimiento[];
  totalNoRegistrados: number;
  cuentas: Cuenta[];
  confirmacionSinActividad?: { confirmadaAt: string; nota: string } | null;
  sinCuentaBancos: boolean;
}


/** La fecha del movimiento viaja como "YYYY-MM-DD" (un instante UTC) y el mes
 *  se corta con Date.UTC. Sin fijar la zona, el navegador la pinta en hora de
 *  México y el primero de mes aparece como el 31 del mes anterior — visto en
 *  pantalla: «31/07/26» dentro del corte de agosto. */
const fFecha = (s: string) =>
  new Date(s).toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });

/** Renglones que se pintan de una vez; «Ver más» agrega otro tanto. */
const PAGINA = 80;

type Filtro = "SIN_CONCILIAR" | "MATCHED" | "IGNORED" | "TODOS";

/** La lista tal como se pinta: filtrada, buscada y con los pendientes arriba.
 *  Pura y a nivel de módulo — no toca el closure, y el orden de la izquierda
 *  se lee entero de un vistazo en vez de repartido por el cuerpo del render. */
function armarLista(movs: Movimiento[], filtro: Filtro, buscar: string): Movimiento[] {
  const q = buscar.trim().toLowerCase();
  return movs
    .filter((m) =>
      filtro === "TODOS" ? true
      : filtro === "SIN_CONCILIAR" ? !m.conciliado
      : m.status === filtro,
    )
    .filter((m) =>
      !q ? true
      : [m.descripcion, m.contraparteNombre ?? "", m.contraparteRfc ?? "", String(Math.abs(m.monto))]
          .some((v) => v.toLowerCase().includes(q)),
    )
    // Los sin conciliar (trabajo real) arriba; los «por contabilizar» al final.
    // El sort es estable: dentro de cada grupo se conserva el orden por fecha.
    .sort((a, b) => Number(a.conciliado ?? false) - Number(b.conciliado ?? false));
}

export function ConciliacionWorkbench({
  companyId,
  year,
  month,
  txInicial,
  onApplied,
}: {
  companyId: string;
  year: number;
  month: number;
  /** Movimiento que el archivo entrega por `?tx=`: se selecciona al llegar el
   *  mes, con el filtro que lo contiene. */
  txInicial?: string | null;
  /** Se llama tras aplicar una conciliación (para refrescar el papel de abajo). */
  onApplied?: () => void;
}) {
  const [data, setData] = useState<ConciliacionMes | null>(null);
  const [cargando, setCargando] = useState(true);
  const [selTx, setSelTx] = useState<Movimiento | null>(null);
  const [autoCorriendo, setAutoCorriendo] = useState(false);
  // Filtro y búsqueda de la LISTA — lo que sólo tenía el tab Movimientos. La
  // mesa mostraba nada más los pendientes, así que revisar algo ya conciliado
  // obligaba a cambiar de pestaña, que es de donde venía la doble mesa.
  const [filtro, setFiltro] = useState<Filtro>("SIN_CONCILIAR");
  const [buscar, setBuscar] = useState("");
  // Selección en lote — lo último que sólo existía en el tab Movimientos.
  // Veinte comisiones se categorizan de un golpe sin salir de la mesa.
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Conciliar el cobro de una PPD obliga a timbrar su complemento. El panel ya
  // avisaba, pero la mesa no le pasaba el callback y la sugerencia se perdía:
  // conciliar aquí —la pantalla por defecto— nunca ofrecía el REP.
  const [repSugerido, setRepSugerido] = useState<RepSugerido | null>(null);
  const [verFacturaId, setVerFacturaId] = useState<string | null>(null);
  /** id del movimiento cuyo cruce se está deshaciendo. */
  const [deshaciendo, setDeshaciendo] = useState<string | null>(null);
  /** El `?tx=` ya honrado: la entrega desde el archivo ocurre una sola vez. */
  const entregado = useRef<string | null>(null);
  // Tope de RENDERIZADO, no de datos: el feed trae el mes completo (un hospital
  // pasa de 300 movimientos) y pintarlos todos deja la lista pesada y sin fondo
  // visible. Los filtros y la búsqueda corren sobre TODO el mes; esto sólo
  // decide cuántos renglones se dibujan.
  const [visibles, setVisibles] = useState(PAGINA);

  // Anticipos sin CFDI: obligaciones abiertas con dinero encima. Se cargan
  // aparte del mes porque no dependen del periodo — un anticipo de hace tres
  // meses sigue debiendo su comprobante hoy.
  const [anticipos, setAnticipos] = useState<ResumenAnticipos | null>(null);
  const cargarAnticipos = useCallback(() => {
    fetch(`/api/bancos/anticipos?companyId=${companyId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAnticipos(d))
      .catch(() => {});
  }, [companyId]);
  useEffect(() => { cargarAnticipos(); }, [cargarAnticipos]);
  const [aviso, setAviso] = useState<React.ReactNode>("");
  const [error, setError] = useState("");
  // Filtro por cuenta (client-side: el feed ya trae la cuenta de cada
  // movimiento). null = todas. Se resetea al cambiar de período/empresa.
  const [cuentaSel, setCuentaSel] = useState<string | null>(null);
  // Contexto de la cuenta elegida (banco ··4 · saldo del estado de cuenta),
  // del GET /api/bancos existente. Si la consulta falla, la línea no aparece.
  const [detalleCuentas, setDetalleCuentas] = useState<Map<string, CuentaDetalle>>(new Map());

  // Fallo del fetch, SEPARADO de data=null: antes un error dejaba data=null y
  // la mesa entera desaparecía sin decir nada (idéntico al caso "sin cuenta
  // bancaria", que sí es genuino y se oculta a propósito).
  const [errorCarga, setErrorCarga] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga("");
    try {
      const res = await fetch(`/api/bancos/conciliacion?companyId=${companyId}&year=${year}&month=${month}`);
      const d = await res.json();
      if (!res.ok || !d?.movimientosNoRegistrados) throw new Error();
      setData(d);
    } catch {
      setData(null);
      setErrorCarga("No se pudo cargar la conciliación bancaria. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setCargando(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    setSelTx(null);
    setCuentaSel(null);
    setSelectMode(false);
    setPicked(new Set());
    cargar();
  }, [cargar]);

  // Cambiar de filtro, de búsqueda o de cuenta cambia QUÉ lista se ve: arrastrar
  // ahí una selección hecha sobre otra (o el scroll de la anterior) aplicaría el
  // lote a movimientos que ya no están en pantalla.
  useEffect(() => {
    setPicked(new Set());
    setVisibles(PAGINA);
  }, [filtro, buscar, cuentaSel, data]);

  // Una vez por empresa: el detalle no depende del período.
  useEffect(() => {
    let vivo = true;
    fetch(`/api/bancos?companyId=${companyId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((xs: CuentaDetalle[]) => {
        if (vivo && Array.isArray(xs)) setDetalleCuentas(new Map(xs.map((c) => [c.id, c])));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [companyId]);

  // La derecha nunca abre muerta: al llegar el mes (o cambiar de cuenta) se
  // elige el primer movimiento pendiente, para que los candidatos se enseñen
  // solos — la mesa abría con la caja vacía y parecía rota. Deseleccionar con
  // clic sigue funcionando: esto sólo corre cuando cambian datos o filtro, no
  // cuando el usuario suelta la selección. Tras conciliar, cargar() trae datos
  // nuevos y esto avanza solo al siguiente pendiente.
  useEffect(() => {
    if (!data) return;
    // ENTREGA DESDE EL ARCHIVO (`?tx=`). Manda sobre el auto-seleccionado, y
    // una sola vez por id: después el usuario navega sin que el enlace lo
    // devuelva al mismo renglón. El filtro se acomoda al movimiento — llegar
    // con «Sin conciliar» a uno ya conciliado lo dejaría fuera de la lista. De
    // que se vea aunque caiga en el renglón 300 se encarga el render (`hasta`).
    if (txInicial && entregado.current !== txInicial) {
      const m = data.movimientosBanco.find((x) => x.id === txInicial);
      if (m) {
        const f: Filtro = !m.conciliado ? "SIN_CONCILIAR" : m.status === "MATCHED" ? "MATCHED" : "IGNORED";
        entregado.current = txInicial;
        setFiltro(f);
        setBuscar("");
        setCuentaSel(null);
        setSelTx(m);
        return;
      }
      // El mes llegó sin ese movimiento (se borró, o el enlace venía torcido):
      // no se insiste en cada recarga.
      entregado.current = txInicial;
    }
    const lista = cuentaSel
      ? data.movimientosNoRegistrados.filter((m) => m.cuentaBancariaId === cuentaSel)
      : data.movimientosNoRegistrados;
    // El auto-seleccionado es el primer SIN conciliar: un «por contabilizar» no
    // pide trabajo y abriría la mesa sobre algo que no hay que tocar.
    const primero = lista.find((m) => !m.conciliado) ?? lista[0] ?? null;
    setSelTx((prev) => (prev && lista.some((m) => m.id === prev.id) ? prev : primero));
  }, [data, cuentaSel, txInicial]);

  // Búsqueda del humano sobre los candidatos (con debounce): cuando el
  // contador YA sabe qué factura es, tecleársela gana a cualquier score. El
  // servidor ensancha el pool (±365 días, sin tope de monto) y filtra.


  const etiquetaCuenta = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.cuentas ?? []) m.set(c.bankAccountId, c.etiqueta);
    return m;
  }, [data]);

  /** Deshace el cruce del movimiento: `unmatch` si tiene factura o declaración,
   *  `unignore` si sólo se había categorizado. El servidor revierte de paso la
   *  declaración pagada y borra las porciones de la conciliación múltiple. */
  async function deshacerCruce(m: Movimiento) {
    const ignorado = m.status === "IGNORED";
    setDeshaciendo(m.id);
    try {
      const res = await fetch(`/api/bancos/transactions/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: ignorado ? "unignore" : "unmatch" }),
      });
      if (res.ok) {
        setAviso(ignorado ? "Movimiento reabierto" : "Movimiento desconciliado");
        setSelTx(null);
        await cargar();
        onApplied?.();
      } else {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? (ignorado ? "No se pudo reabrir" : "No se pudo desconciliar"));
      }
    } finally {
      setDeshaciendo(null);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function autoConciliar() {
    if (!data || data.cuentas.length === 0) return;
    setAutoCorriendo(true); setError(""); setAviso("");
    try {
      let aplicados = 0;
      for (const c of data.cuentas) {
        const res = await fetch(`/api/bancos/${c.bankAccountId}/match`, { method: "POST" });
        const d = await res.json().catch(() => null);
        if (res.ok) aplicados += d?.autoMatched ?? 0;
      }
      setAviso(
        aplicados > 0
          ? `Auto-conciliación: ${aplicados} ${aplicados === 1 ? "movimiento aplicado" : "movimientos aplicados"} con confianza alta.`
          : "Auto-conciliación: sin matches de confianza alta — los restantes se concilian aquí a mano."
      );
      setSelTx(null);
      await cargar();
      onApplied?.();
    } finally {
      setAutoCorriendo(false);
    }
  }

  if (cargando) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin" /> Cotejando banco contra libro…
      </div>
    );
  }
  // ERROR ≠ "sin cuenta": el fallo de red se dice y ofrece reintentar; el
  // return null de abajo queda sólo para el caso genuino (sin cuenta de
  // bancos, la mesa no aplica).
  if (errorCarga) {
    return (
      <div className="mb-6">
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>{errorCarga}</Alert>
      </div>
    );
  }
  if (!data || data.sinCuentaBancos) return null;

  // Con una cuenta elegida, los tres stats y la lista son DE ESA CUENTA — el
  // % global junto a una lista filtrada diría dos cosas distintas a la vez.
  const deLaCuenta = <T extends { cuentaBancariaId: string }>(xs: T[]) =>
    cuentaSel ? xs.filter((x) => x.cuentaBancariaId === cuentaSel) : xs;
  // Los sin conciliar (trabajo real) arriba; los «por contabilizar» al final. El
  // sort es estable, así que dentro de cada grupo se conserva el orden por
  // fecha con el que llegan del API.
  // La lista sale de TODOS los movimientos del mes, no sólo de los que faltan:
  // con el filtro se elige qué mirar. «Sin conciliar» sigue siendo lo primero
  // que se ve, porque es el trabajo real.
  const delMes = deLaCuenta(data.movimientosBanco);
  // UN CHIP CUENTA LO QUE SU NOMBRE DICE. «Pendientes» contaba lo no
  // registrado —sin conciliar MÁS lo conciliado que espera el asiento— y
  // enseñaba 248 encima de un encabezado que decía «119 sin conciliar»: quien
  // lo lee entiende que le faltan 248 por conciliar cuando le faltan 119. Los
  // conciliados que esperan posteo ya se dicen en su tile y en el encabezado,
  // y salen del mes entero con un clic en el cierre.
  const cuenta = {
    SIN_CONCILIAR: delMes.filter((m) => !m.conciliado).length,
    MATCHED: delMes.filter((m) => m.status === "MATCHED").length,
    IGNORED: delMes.filter((m) => m.status === "IGNORED").length,
    TODOS: delMes.length,
  };
  const lista = armarLista(delMes, filtro, buscar);
  // El seleccionado SIEMPRE se pinta. Sin esto, el movimiento que el archivo
  // entrega (o el que quedó elegido al ampliar la lista) puede caer más allá
  // del tope: el panel lo resuelve a la derecha y la izquierda no lo muestra.
  const idxSel = selTx ? lista.findIndex((m) => m.id === selTx.id) : -1;
  const hasta = idxSel >= visibles ? Math.ceil((idxSel + 1) / PAGINA) * PAGINA : visibles;
  // Lo palomeado se deriva de la lista FILTRADA, no del Set suelto: así el lote
  // nunca puede tocar un movimiento que el filtro de hoy ya no muestra.
  const escogidos = lista.filter((m) => picked.has(m.id));
  // Neto firmado en valor absoluto (un reembolso resta) — la cuenta del motor.
  const escogidosSuma = Math.abs(escogidos.reduce((s, m) => s + m.monto, 0));
  const escogidosConciliados = escogidos.filter((m) => m.conciliado).length;
  const total = deLaCuenta(data.movimientosBanco).length;
  // «Sin conciliar» = status UNMATCHED (el MISMO número que el paso 2 del
  // Inicio); los conciliados de un mes sin postear sólo esperan el posteo.
  const sinConciliar = lista.filter((m) => !m.conciliado).length;
  const esperanPosteo = lista.length - sinConciliar;
  const sin = lista.length;
  const sinGlobal = data.movimientosNoRegistrados.length;
  // Σ|monto|, NO el neto firmado: +$17k de abonos y −$17k de cargos netean a
  // casi cero, y el tile diría «$92 por conciliar» con 12 movimientos por
  // casar. El neto es del motor (la ecuación del cuadre lo necesita firmado);
  // este tile mide cuánto trabajo hay sobre la mesa.
  // …y SÓLO sobre lo que de verdad falta conciliar. Sumar también los ya
  // conciliados que esperan posteo hacía que el tile dijera «$20,207.20 por
  // conciliar» junto a «sin conciliar: 0» — dos cifras que se contradicen a la
  // vista. Lo que espera el posteo se cuenta aparte, con su nombre.
  const porConciliar = lista.filter((m) => !m.conciliado);
  const abonos = porConciliar.reduce((s, m) => s + (m.monto > 0 ? m.monto : 0), 0);
  const cargos = porConciliar.reduce((s, m) => s + (m.monto < 0 ? -m.monto : 0), 0);
  const montoPorContabilizar = lista
    .filter((m) => m.conciliado)
    .reduce((s, m) => s + Math.abs(m.monto), 0);
  const sinActividadConfirmada =
    data.movimientosBanco.length === 0 && data.confirmacionSinActividad != null;
  const cobertura = evaluarCoberturaBancaria(total, sinConciliar, sinActividadConfirmada);
  const sinConciliarGlobal = data.movimientosBanco.filter((m) => !m.conciliado).length;
  const coberturaGlobal = evaluarCoberturaBancaria(
    data.movimientosBanco.length,
    sinConciliarGlobal,
    sinActividadConfirmada,
  );
  const sinDatos = cobertura.estado === "NO_DATA";
  const sinActividad = cobertura.estado === "NO_ACTIVITY_CONFIRMED";

  return (
    <div className="mb-6">
      <StatStrip className="sm:grid-cols-3">
        <StatTile
          label="Conciliado"
          tone={cobertura.compuertaAbierta ? "jade" : "ink"}
          value={sinActividad ? "Sin actividad" : cobertura.porcentajeConciliado == null ? "Sin datos" : `${cobertura.porcentajeConciliado.toFixed(1)} %`}
          sub={sinActividad ? "Confirmado por el contador" : sinDatos ? "No hay movimientos para este periodo" : `${cobertura.movimientosConciliados} de ${total} movimientos del mes`}
        />
        <StatTile
          label="Sin conciliar"
          tone={cobertura.compuertaAbierta ? "jade" : sinConciliar > 20 ? "red" : sinConciliar > 0 ? "amber" : "ink"}
          value={sinConciliar}
          sub={esperanPosteo > 0 ? `+ ${esperanPosteo} conciliado${esperanPosteo === 1 ? "" : "s"} por contabilizar` : undefined}
        />
        <StatTile
          label="Por conciliar"
          tone={cobertura.compuertaAbierta ? "jade" : "ink"}
          value={<Money value={abonos + cargos} size={20} />}
          sub={
            abonos > 0 && cargos > 0 ? (
              <>
                abonos <Money value={abonos} className="text-[12px]" muted /> · cargos{" "}
                <Money value={cargos} className="text-[12px]" muted />
              </>
            ) : montoPorContabilizar > 0 ? (
              <>
                <Money value={montoPorContabilizar} className="text-[12px]" muted /> ya conciliados, esperan la contabilización
              </>
            ) : undefined
          }
        />
      </StatStrip>

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

      {data.cuentas.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {[{ bankAccountId: null as string | null, etiqueta: "Todas las cuentas" }, ...data.cuentas].map((c) => (
            <button
              key={c.bankAccountId ?? "__todas__"}
              onClick={() => { setCuentaSel(c.bankAccountId); setSelTx(null); }}
              className={cn(
                "inline-flex items-center rounded-full border px-3.5 py-1.5 text-[13px] font-medium",
                cuentaSel === c.bankAccountId
                  ? "border-cos-brand bg-cos-brand text-white"
                  : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink"
              )}
            >
              {c.etiqueta}
            </button>
          ))}
        </div>
      )}

      {/* Contexto de la cuenta elegida. El saldo es el del último renglón del
          estado de cuenta (con su fecha) — y sólo cuando el banco lo trae:
          sin saldo no se muestra un cero que nadie midió. El conteo es
          histórico de la cuenta, no del mes (los tiles de arriba ya son del
          mes), por eso dice «en total». */}
      {cuentaSel && detalleCuentas.has(cuentaSel) && (() => {
        const d = detalleCuentas.get(cuentaSel)!;
        return (
          <p className="-mt-2 mb-4 font-mono text-[11px] text-cos-ink-faint">
            {d.banco} ··{d.numeroCuenta.slice(-4)} · {d.stats.total.toLocaleString("es-MX")} movimientos en total
            {d.lastTransaction?.saldo != null && (
              <>
                {" "}· saldo <Money value={d.lastTransaction.saldo} className="text-[11px]" muted /> al{" "}
                {fFecha(d.lastTransaction.fecha)}
              </>
            )}
          </p>
        );
      })()}

      {sin === 0 ? (
        <div className="rounded-card border border-cos-line bg-cos-card px-5 py-4 text-sm text-cos-ink-soft">
          {/* «Compuerta abierta» sólo cuando el MES entero está limpio: con una
              cuenta filtrada en cero pero otras pendientes, decirlo mentiría. */}
          {coberturaGlobal.estado === "NO_ACTIVITY_CONFIRMED"
            ? "Periodo confirmado sin actividad bancaria — la compuerta está abierta por una decisión humana auditable, no por un 100% calculado."
            : coberturaGlobal.estado === "NO_DATA"
            ? "No hay movimientos bancarios en este periodo. Importa el estado de cuenta; sin datos la compuerta del cierre permanece cerrada."
            : sinDatos
              ? "Esta cuenta no tiene movimientos en el periodo; revisa su estado de cuenta antes de confirmar el cierre."
              : sinGlobal === 0
                ? "Todos los movimientos del mes están conciliados — la compuerta del cierre está abierta."
                : `Esta cuenta está al corriente; ${sinGlobal === 1 ? "queda 1 movimiento" : `quedan ${sinGlobal} movimientos`} en otras cuentas.`}
        </div>
      ) : (
        <>
        {/* ANTICIPOS SIN CFDI. No es un banner que se cierra: es una lista de
            obligaciones con dinero encima, ordenada por ANTIGÜEDAD, porque eso
            es lo que la vuelve grave. Etiquetar el movimiento no lo saca de
            aquí — sólo lo saca el comprobante. */}
        {anticipos && anticipos.total > 0 && (
          <div className={cn(
            "rounded-card border bg-cos-card",
            anticipos.vencidos > 0 ? "border-cos-red-ink/40" : "border-cos-amber-ink/40",
          )}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-cos-line px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-cos-ink">Anticipos sin CFDI</h2>
                <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
                  <Money value={anticipos.monto} size={12.5} /> en {anticipos.total}{" "}
                  {anticipos.total === 1 ? "movimiento" : "movimientos"}
                  {anticipos.porFacturar > 0 && ` · ${anticipos.porFacturar} que debemos facturar`}
                  {anticipos.porRecibir > 0 && ` · ${anticipos.porRecibir} que el proveedor debe comprobar`}
                </p>
              </div>
              {anticipos.vencidos > 0 && (
                <span className="rounded-full bg-cos-red-tint px-2.5 py-1 text-[12px] font-semibold text-cos-red-ink">
                  {anticipos.vencidos} con más de 30 días · <Money value={anticipos.montoVencido} size={12} />
                </span>
              )}
            </div>
            <ul className="divide-y divide-cos-line-soft">
              {anticipos.anticipos.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className={cn(
                    "h-2 w-2 flex-none rounded-full",
                    a.severidad === "vencido" ? "bg-cos-red-ink"
                      : a.severidad === "atencion" ? "bg-cos-amber-ink" : "bg-cos-line",
                  )} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-cos-ink">
                      {a.cliente ?? a.descripcion}
                    </p>
                    <p className="text-[11.5px] text-cos-ink-faint">
                      {a.fecha} · {a.direccion === "CLIENTE" ? "emitir CFDI de anticipo" : "pedir CFDI al proveedor"}
                      {a.rfc ? ` · ${a.rfc}` : ""}
                    </p>
                  </div>
                  <span className={cn(
                    "flex-none text-[12px] font-medium tabular-nums",
                    a.severidad === "vencido" ? "text-cos-red-ink"
                      : a.severidad === "atencion" ? "text-cos-amber-ink" : "text-cos-ink-faint",
                  )}>
                    {a.dias} d
                  </span>
                  <Money value={a.monto} size={13} className="flex-none" />
                </li>
              ))}
            </ul>
            {anticipos.total > 8 && (
              <p className="border-t border-cos-line px-5 py-2 text-[12px] text-cos-ink-faint">
                y {anticipos.total - 8} más
              </p>
            )}
          </div>
        )}

        <div className="rounded-card border border-cos-line bg-cos-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-5 py-3.5">
            <h2 className="text-sm font-semibold text-cos-ink">Mesa de conciliación</h2>
            <button
              onClick={autoConciliar}
              disabled={autoCorriendo}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {autoCorriendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Correr auto-conciliación
            </button>
          </div>

          {/* `min-w-0` EN LAS DOS COLUMNAS, y no es cosmético: por defecto un
              hijo de grid tiene `min-width: auto`, o sea que NO puede encogerse
              por debajo del ancho mínimo de su contenido. La columna derecha
              trae piezas que no se pueden encoger —el importe, los chips de
              confianza, el botón de conciliar— así que fijaba un mínimo grande,
              el grid se desbordaba de su tarjeta y la derecha quedaba CORTADA
              fuera de la pantalla. Con min-w-0 las columnas ceden y el
              `truncate` de adentro hace su trabajo. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-cos-line">
            {/* ── Izquierda: movimientos del banco ── */}
            <section className="flex min-w-0 flex-col">
              <p className="border-b border-cos-line-soft px-5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                Movimientos del banco · {sinConciliar} sin conciliar{esperanPosteo > 0 ? ` · ${esperanPosteo} por contabilizar` : ""}{cuentaSel ? " en esta cuenta" : ""}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 border-b border-cos-line-soft px-5 py-2">
                {([
                  ["SIN_CONCILIAR", "Sin conciliar"],
                  ["MATCHED", "Conciliados"],
                  ["IGNORED", "Categorizados"],
                  ["TODOS", "Todos"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setFiltro(id)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[12px] font-medium",
                      filtro === id
                        ? "bg-cos-brand text-white"
                        : "bg-cos-paper text-cos-ink-soft hover:bg-cos-line-soft",
                    )}
                  >
                    {label} <span className="tabular-nums opacity-70">{cuenta[id]}</span>
                  </button>
                ))}
                <input
                  value={buscar}
                  onChange={(e) => setBuscar(e.target.value)}
                  placeholder="Buscar concepto, contraparte, RFC o importe…"
                  className="ml-auto min-w-[180px] flex-1 rounded-control border border-cos-line bg-cos-paper px-2.5 py-1 text-[12.5px] text-cos-ink placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none"
                />
                <button
                  onClick={() => { setSelectMode((v) => !v); setPicked(new Set()); }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold",
                    selectMode ? "bg-cos-ink text-cos-canvas" : "text-cos-ink-soft hover:bg-cos-paper",
                  )}
                >
                  <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? "Salir de selección" : "Seleccionar"}
                </button>
              </div>
              {/* Con filtro y búsqueda encima, «los N de esta lista» es el gesto
                  real: filtrar COMISION y palomear todo de un tirón. Marca lo
                  FILTRADO, no lo que alcanza a estar pintado — el tope de
                  renglones es de dibujo, no de alcance. */}
              {selectMode && (
                <div className="flex flex-wrap items-center gap-3 border-b border-cos-line-soft bg-cos-paper px-5 py-1.5 text-[12px] text-cos-ink-soft">
                  <span className="tabular-nums">
                    {picked.size} de {lista.length} {lista.length === 1 ? "seleccionado" : "seleccionados"}
                  </span>
                  <button
                    onClick={() => setPicked(new Set(lista.map((m) => m.id)))}
                    className="font-semibold text-cos-brand-ink hover:underline"
                  >
                    Seleccionar {lista.length === 1 ? "el de la lista" : `los ${lista.length} de la lista`}
                  </button>
                  {picked.size > 0 && (
                    <button onClick={() => setPicked(new Set())} className="font-semibold text-cos-ink-soft hover:underline">
                      Ninguno
                    </button>
                  )}
                </div>
              )}
              {/* Cada columna con su propio scroll. Antes la lista crecía sin
                  tope en escritorio para no dejar un hueco cuando la columna
                  derecha era más alta —el grid estiraba las dos—, pero con el
                  panel pegado (`self-start`) ya no se estira, y sin tope la
                  página entera hacía scroll y el panel se iba de vista. */}
              <ul className="max-h-[430px] flex-1 overflow-y-auto lg:max-h-screen lg:min-h-[430px]">
                {lista.slice(0, hasta).map((m) => {
                  const activo = selTx?.id === m.id;
                  const palomeado = picked.has(m.id);
                  return (
                    <li key={m.id}>
                      <button
                        // En modo selección el renglón palomea; fuera de él,
                        // abre el panel. Un botón dentro de otro es HTML
                        // inválido, así que la casilla es un <span> y el
                        // renglón entero cambia de oficio.
                        onClick={() => (selectMode ? togglePick(m.id) : setSelTx(activo ? null : m))}
                        aria-pressed={selectMode ? palomeado : undefined}
                        className={cn(
                          "flex w-full items-baseline justify-between gap-3 border-b border-cos-line-soft px-5 py-2.5 text-left",
                          (selectMode ? palomeado : activo)
                            ? "bg-cos-brand-tint shadow-[inset_3px_0_0_var(--brand)]"
                            : "hover:bg-cos-paper"
                        )}
                      >
                        {selectMode && (
                          <span className="relative top-[3px] flex-none" aria-hidden>
                            {palomeado
                              ? <CheckSquare className="h-[17px] w-[17px] text-cos-brand" />
                              : <span className="block h-[17px] w-[17px] rounded-[5px] border-[1.5px] border-cos-line" />}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          {/* La contraparte extraída manda; la cadena cruda del
                              banco sólo cuando no hay nada mejor (misma regla,
                              con el mismo porqué, que el tab Movimientos). */}
                          <span className="block truncate text-[13px] font-medium text-cos-ink">
                            {m.contraparteNombre || m.descripcion || "(sin descripción)"}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-cos-ink-faint">
                            {/* Sin el chip, un movimiento ya conciliado (que en
                                Movimientos luce ✓) aparece aquí idéntico a uno
                                pendiente y parece trabajo por hacer — cuando
                                sólo espera el posteo del mes. */}
                            {m.conciliado && (
                              <span className="mr-1.5 rounded-full bg-cos-jade-tint px-1.5 py-px font-sans text-[10px] font-semibold text-cos-jade-ink">
                                Conciliado · por contabilizar
                              </span>
                            )}
                            {fFecha(m.fecha)}
                            {m.contraparteRfc && <> · <span className="text-cos-ink-soft">{m.contraparteRfc}</span></>}
                            {m.conceptoPago && ` · ${m.conceptoPago}`}
                            {!m.contraparteNombre && " · sin identificar"}
                            {etiquetaCuenta.get(m.cuentaBancariaId) && ` · ${etiquetaCuenta.get(m.cuentaBancariaId)}`}
                          </span>
                        </span>
                        <Money
                          value={m.monto}
                          className={cn("text-[13px]", m.monto < 0 && "text-cos-red-ink")}
                        />
                      </button>
                    </li>
                  );
                })}
                {lista.length > hasta && (
                  <li className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <button
                      onClick={() => setVisibles(hasta + PAGINA)}
                      className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink"
                    >
                      Ver {Math.min(PAGINA, lista.length - hasta)} más
                    </button>
                    <span className="text-[11.5px] text-cos-ink-faint tabular-nums">
                      {hasta} de {lista.length.toLocaleString("es-MX")}
                    </span>
                  </li>
                )}
              </ul>
            </section>

            {/* ── Derecha: resolver el movimiento ──
                EL MISMO panel que la lista de Movimientos. Antes había aquí una
                copia más pobre: repartía las porciones sola en vez de dejar
                editarlas, y no tenía búsqueda manual de facturas, comprobante
                CEP, pagos de impuestos ni desconciliar. Conciliar daba un
                resultado distinto según la pestaña. */}
            {/* PEGADO AL SCROLL. La lista de la izquierda crece con el mes —148
                movimientos en un hospital— y sin esto el panel se iba hacia
                arriba: bajabas a buscar un movimiento y perdías de vista dónde
                resolverlo. `self-start` es lo que le da lugar al sticky dentro
                del grid; sin eso la celda se estira y no hay dónde pegarse. */}
            <section className="min-w-0 border-t border-cos-line lg:sticky lg:top-0 lg:self-start lg:max-h-screen lg:overflow-y-auto lg:border-t-0">
              <p className="sticky top-0 z-10 border-b border-cos-line-soft bg-cos-card px-5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                {selTx ? "Resolver el movimiento" : "CFDI candidatos"}
              </p>
              {!selTx ? (
                <div className="flex h-full min-h-[200px] items-center justify-center px-8 py-10 text-center text-sm text-cos-ink-soft">
                  <span>
                    <Landmark className="mx-auto mb-2 h-6 w-6 opacity-30" />
                    Elige un movimiento a la izquierda para ver sus candidatos —
                    del mismo sentido, puntuados por identidad (RFC y nombre), monto y fecha.
                  </span>
                </div>
              ) : (
                <div className="px-5 pb-4">
                  {selTx.conciliado && (
                    <div className="mt-3 rounded-card border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-2 text-[12.5px] text-cos-jade-ink">
                      {selTx.status === "IGNORED"
                        ? "Este movimiento se categorizó sin factura. El cierre lo asienta con su etiqueta."
                        : "Este movimiento ya está conciliado — no hay nada que volver a cruzar."}{" "}
                      Entra en libros al{" "}
                      <Link href="/contabilidad/cierre" className="font-medium underline">
                        contabilizar el mes
                      </Link>
                      , un solo clic para todo el período.
                      {/* DESHACER, aquí. Desde #970 la mesa puede filtrar a
                          Conciliados y mirar lo hecho, pero corregirse seguía
                          exigiendo el tab Movimientos: equivocarse conciliando
                          es normal; no poder deshacerlo donde se ve, no. */}
                      <button
                        onClick={() => deshacerCruce(selTx)}
                        disabled={deshaciendo === selTx.id}
                        className="mt-2 block text-[12.5px] font-semibold text-cos-red-ink hover:underline disabled:opacity-50"
                      >
                        {deshaciendo === selTx.id
                          ? "…"
                          : selTx.status === "IGNORED" ? "Reabrir movimiento" : "Desconciliar"}
                      </button>
                    </div>
                  )}
                  <ResolverMovimiento
                    key={selTx.id}
                    tx={{
                      id: selTx.id,
                      bankAccountId: selTx.cuentaBancariaId,
                      fecha: selTx.fecha,
                      descripcion: selTx.descripcion,
                      monto: selTx.monto,
                      contraparteNombre: selTx.contraparteNombre,
                      contraparteClabe: selTx.contraparteClabe,
                      claveRastreo: selTx.claveRastreo,
                    }}
                    companyId={companyId}
                    onCambio={cargar}
                    onToast={setAviso}
                    onVerFactura={setVerFacturaId}
                    onRepSugerido={setRepSugerido}
                    onResuelto={() => setSelTx(null)}
                  />
                </div>
              )}
            </section>
          </div>
        </div>

        {/* La barra del lote — el MISMO componente que monta Movimientos. Va
            FUERA de la tarjeta y pegada al fondo de la ventana: la lista tiene
            su propio scroll, así que dentro de ella se perdería de vista justo
            cuando hay algo palomeado. */}
        {selectMode && (
          <AccionesEnLote
            companyId={companyId}
            txIds={escogidos.map((m) => m.id)}
            suma={escogidosSuma}
            conciliados={escogidosConciliados}
            onToast={setAviso}
            onListo={async () => {
              setPicked(new Set());
              setSelectMode(false);
              setSelTx(null);
              await cargar();
              onApplied?.();
            }}
          />
        )}
        </>
      )}

      {repSugerido && (
        <AvisoRepSugerido
          rep={repSugerido}
          companyId={companyId}
          onCerrar={() => setRepSugerido(null)}
          onToast={setAviso}
        />
      )}
      {verFacturaId && (
        <RepresentacionImpresa invoiceId={verFacturaId} onClose={() => setVerFacturaId(null)} />
      )}
    </div>
  );
}
