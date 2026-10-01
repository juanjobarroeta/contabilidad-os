"use client";

// ─────────────────────────────────────────────────────────────────────────────
// 05 · Historial — la cuadrícula de 5 años que se va llenando con lo que de
// verdad baja del SAT (GET /api/onboarding/estado, cada 5 s). La mascota se
// posa sobre el mes que se está pidiendo; el registro narra lo que cambió
// entre lecturas (historial.narrar). El botón para seguir aparece cuando los
// 3 meses más recientes están completos; «Seguir sin esperar» siempre está.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { cifraCorta, MESES_LARGOS, narrar, type EventoHistorial, type MesHistorial } from "@/lib/onboarding/historial";
import { LINEAS, t } from "@/lib/onboarding/lineas";
import { Burbuja, Slot, useEscena } from "./escena";
import type { EstadoAlta } from "./tipos";
import { cn } from "@/lib/utils";

const MES_CORTO = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const fmt = (n: number) => n.toLocaleString("es-MX");
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const ETIQUETA_CELDA: Partial<Record<MesHistorial["estado"], string>> = { quota: "pausa", error: "reviso", cur: "en curso" };

interface Renglon extends EventoHistorial {
  hora: string;
}

export function PantallaHistorial({
  estado,
  onCambiarAnios,
  onSeguir,
}: {
  estado: EstadoAlta | null;
  onCambiarAnios: (anios: number) => Promise<void>;
  onSeguir: () => void;
}) {
  const { decir, festejar, sobre, aSlot, mirar, tono } = useEscena();
  const [log, setLog] = useState<Renglon[]>([]);
  const [pop, setPop] = useState<Set<string>>(new Set());
  const [aniosAbierto, setAniosAbierto] = useState(false);
  const previo = useRef<MesHistorial[] | null | undefined>(undefined);
  const yaDijo = useRef(new Set<string>());

  useEffect(() => {
    void decir(t(LINEAS.historial, tono));
    return () => mirar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cada lectura nueva: narrar lo que cambió, festejar meses nuevos y
  // posar la mascota sobre el mes que se está pidiendo.
  useEffect(() => {
    if (!estado) return;
    const antes = previo.current === undefined ? null : previo.current;
    const eventos = narrar(antes, estado.meses).filter((e) => !yaDijo.current.has(e.clave));
    eventos.forEach((e) => yaDijo.current.add(e.clave));
    if (eventos.length) {
      const hora = hhmm(new Date());
      setLog((l) => [...eventos.map((e) => ({ ...e, hora })).reverse(), ...l].slice(0, 40));
      const voz = [...eventos].reverse().find((e) => e.decir);
      if (voz) {
        if (voz.clave === "reciente") void decir(LINEAS.historialReciente);
        else void decir(voz.texto);
        if (voz.clase === "logro") festejar();
      }
    }
    if (antes) {
      const nuevos = estado.meses.filter((m) => m.estado === "ok" && antes.find((a) => a.y === m.y && a.m === m.m)?.estado !== "ok");
      if (nuevos.length) {
        setPop(new Set(nuevos.map((m) => `${m.y}-${m.m}`)));
        setTimeout(() => setPop(new Set()), 400);
      }
    }
    previo.current = estado.meses;

    // El mes en vuelo más reciente; si no hay, la mascota vuelve a su lugar.
    const enVuelo = estado.meses.find((m) => m.estado === "req");
    const celda = enVuelo ? document.getElementById(`ob-mc-${enVuelo.y}-${enVuelo.m}`) : null;
    requestAnimationFrame(() => {
      if (celda) sobre(celda);
      else {
        aSlot();
        mirar(null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado]);

  if (!estado) {
    return (
      <div className="ob-cols top">
        <div className="ob-lcol">
          <Slot escala={1} />
          <Burbuja />
        </div>
        <div className="ob-rcol">
          <p className="ob-kick">Paso 4 · Tu historial</p>
          <h1>Preparando tu historial…</h1>
        </div>
      </div>
    );
  }

  const { meses, resumen, conteos, etapas } = estado;
  const porLlave = new Map(meses.map((m) => [`${m.y}-${m.m}`, m]));
  const anios = [...new Set(meses.map((m) => m.y))].sort((a, b) => b - a);
  const total = resumen.total;
  const fuentes: Array<{ id: string; label: string; n: number; falta?: number }> = [
    { id: "cfdi", label: "Facturas (CFDI)", n: resumen.ok },
    { id: "decl", label: "Declaraciones mensuales", n: resumen.declaraciones, falta: meses.filter((m) => m.decl === "no").length },
    { id: "ce", label: "Contabilidad electrónica (balanzas)", n: resumen.balanzas },
  ];
  const opinion = estado.opinion?.resultado;

  return (
    <div className="ob-cols top">
      <div className="ob-lcol">
        <Slot escala={1} />
        <Burbuja />
        <ul className="ob-log" aria-label="Lo que va pasando">
          {log.map((r) => (
            <li key={r.clave} className={r.clase === "normal" ? "" : r.clase}>
              <time>{r.hora}</time>
              <span>{r.texto}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 4 · Tu historial</p>
        <h1>
          Traigo {estado.empresa.anios} {estado.empresa.anios === 1 ? "año" : "años"} de tu historial del SAT
        </h1>
        <div className="ob-honest">
          <Info size={16} />
          <span>
            El SAT entrega por tandas y con límite por RFC: esto tarda de horas a un par de días. <b>No tienes que esperar aquí:</b> en
            cuanto tenga lo reciente, entras y yo sigo trabajando.{" "}
            <button type="button" className="font-semibold text-cos-brand-ink hover:underline" onClick={() => setAniosAbierto((v) => !v)}>
              ¿Cuántos años?
            </button>
            {aniosAbierto && (
              <span className="ml-2 inline-flex gap-1">
                {[1, 3, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-xs font-semibold",
                      n === estado.empresa.anios ? "border-cos-brand bg-cos-brand-tint text-cos-brand-ink" : "border-cos-line bg-cos-card",
                    )}
                    onClick={async () => {
                      setAniosAbierto(false);
                      if (n !== estado.empresa.anios) await onCambiarAnios(n);
                    }}
                  >
                    {n}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>

        <div className="ob-panel ob-bf">
          <div>
            <div className="ob-grid" role="grid" aria-label="Meses descargados del SAT">
              <span />
              {MES_CORTO.map((m) => (
                <span key={m} className="mh">
                  {m}
                </span>
              ))}
              {anios.map((y) => (
                <Fila key={y} y={y} porLlave={porLlave} pop={pop} />
              ))}
            </div>
            <div className="ob-legend">
              <span><i />Descargado</span>
              <span><i className="e" />Pendiente</span>
              <span><i className="a" />Lo reviso de nuevo</span>
              <span><i className="c" />Mes en curso</span>
              <span><i className="d" />Declaración presentada</span>
              <span><i className="ce" />Contabilidad electrónica</span>
              <span><i className="nd" />Declaración no encontrada</span>
            </div>
          </div>
          <div className="ob-ctrs">
            <div className="ob-ctr"><span>Facturas (CFDI)</span><b>{fmt(conteos.cfdis)}</b></div>
            <div className="ob-ctr"><span>Clientes</span><b>{fmt(conteos.clientes)}</b></div>
            <div className="ob-ctr"><span>Proveedores</span><b>{fmt(conteos.proveedores)}</b></div>
          </div>
        </div>

        <div className="ob-duo">
          <div className="ob-panel">
            <p className="ob-lbl" style={{ marginBottom: 12 }}>Lo que traigo del SAT</p>
            <div className="ob-stages">
              {fuentes.map((f) => {
                const completo = total > 0 && f.n >= total;
                const aviso = !!f.falta && f.falta > 0;
                return (
                  <div key={f.id} className={cn("ob-stg", completo && "done", aviso && "warn")}>
                    <span>{f.label}</span>
                    <b>
                      {f.n} de {total}
                      {aviso ? ` · ${f.falta === 1 ? "falta 1" : `faltan ${f.falta}`}` : ""}
                    </b>
                    <div className="bar"><i style={{ width: `${total ? Math.min(100, (f.n / total) * 100) : 0}%` }} /></div>
                  </div>
                );
              })}
              <div className={cn("ob-stg", opinion === "POSITIVA" && "done", opinion && opinion !== "POSITIVA" && "warn")}>
                <span>Opinión de cumplimiento</span>
                <b>{opinion === "POSITIVA" ? "Positiva ✓" : opinion === "NEGATIVA" ? "Negativa" : opinion ? "Sin opinión" : "Pendiente"}</b>
              </div>
            </div>
          </div>
          <div className="ob-panel">
            <p className="ob-lbl" style={{ marginBottom: 12 }}>Lo que hago con cada factura</p>
            <div className="ob-stages">
              {etapas.map((e) => {
                const pct = e.clave === "cfdis" ? (total ? Math.round((resumen.ok / total) * 100) : 0) : e.pct ?? 0;
                const hecho = e.clave === "cfdis" ? resumen.completo : e.total > 0 && e.completa;
                return (
                  <div key={e.clave} className={cn("ob-stg", hecho && "done")}>
                    <span>{e.etiqueta}</span>
                    <b>{pct}%</b>
                    <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="ob-acts">
          <div className={cn("ob-acts ob-later", resumen.recienteListo && "show")}>
            <button type="button" className="ob-btn p" onClick={onSeguir} tabIndex={resumen.recienteListo ? 0 : -1}>
              Seguir: conectar mi banco
            </button>
            <span className="ob-fine">El historial sigue bajando mientras tanto.</span>
          </div>
          {!resumen.recienteListo && (
            <button type="button" className="ob-btn g" onClick={onSeguir}>
              Seguir sin esperar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Fila({ y, porLlave, pop }: { y: number; porLlave: Map<string, MesHistorial>; pop: Set<string> }) {
  return (
    <>
      <span className="yr">{y}</span>
      {Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const x = porLlave.get(`${y}-${m}`);
        if (!x) return <span key={m} className="ob-mc fuera" />;
        const etiqueta = x.estado === "ok" ? cifraCorta(x.cfdis) : x.estado === "hole" ? cifraCorta(x.cfdis) : ETIQUETA_CELDA[x.estado] ?? "";
        const titulo = `${MESES_LARGOS[m - 1]} ${y}: ${
          {
            ok: `${fmt(x.cfdis)} facturas`,
            req: "pedido al SAT",
            pendiente: "pendiente",
            quota: "el SAT pidió esperar",
            hole: `llegó incompleto (el SAT dice ${fmt(x.satDijo)})`,
            error: "lo vuelvo a pedir",
            cur: "mes en curso",
            fuera: "",
          }[x.estado]
        }${x.decl === "si" ? " · declaración presentada" : x.decl === "no" ? " · declaración no encontrada" : ""}${x.ce ? " · balanza" : ""}`;
        return (
          <span
            key={m}
            id={`ob-mc-${y}-${m}`}
            role="gridcell"
            title={titulo}
            aria-label={titulo}
            className={cn(
              "ob-mc",
              x.estado,
              pop.has(`${y}-${m}`) && "pop",
              x.decl === "si" && "decl",
              x.decl === "no" && "nodecl",
              x.ce && "ce",
            )}
          >
            {etiqueta}
          </span>
        );
      })}
    </>
  );
}
