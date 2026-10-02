"use client";

// Pantallas 01–03 del alta: Bienvenida (perfil), Personaje (piel + tono) y
// Confianza (las cuatro promesas, una a la vez).

import { useEffect, useRef, useState } from "react";
import { Building2, Eye, Lock, MessageSquare, RotateCcw, Users } from "lucide-react";
import { IDS_PERSONAJE, MAX_NOMBRE, PERSONAJES, indiceColor, nombreDe, type IdPersonaje, type Piel } from "@/lib/copiloto/personajes";
import { LINEAS, TONOS_INFO, VISTA_PREVIA_TONO, t } from "@/lib/onboarding/lineas";
import type { Perfil, Tono } from "@/lib/onboarding/progreso";
import { PetSkin } from "@/components/ai/PetSkin";
import { Burbuja, Slot, useEscena } from "./escena";
import { cn } from "@/lib/utils";

const espera = (ms: number, reducir: boolean) => new Promise((r) => setTimeout(r, reducir ? Math.min(ms, 120) : ms));

// ── 01 · Bienvenida ─────────────────────────────────────────────────────────

export function PantallaHola({ pagado, onPerfil }: { pagado: boolean; onPerfil: (p: Perfil) => Promise<boolean> }) {
  const { decir, nombre, mirar, reducir } = useEscena();
  const [elegido, setElegido] = useState<Perfil | null>(null);

  useEffect(() => {
    const t0 = setTimeout(() => void decir((pagado ? "Pago recibido. " : "") + LINEAS.hola(nombre)), reducir ? 0 : 950);
    return () => clearTimeout(t0);
    // Sólo al entrar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function elegir(p: Perfil, el: HTMLElement) {
    if (elegido) return;
    setElegido(p);
    mirar(el);
    await decir(LINEAS.perfil(p));
    await espera(700, reducir);
    if (!await onPerfil(p)) setElegido(null);
  }

  return (
    <div className="ob-hello">
      <Slot escala={2.4} />
      <p className="ob-kick">Bienvenido a ContabilidadOS</p>
      <h1>Hola. Yo te acompaño a dar de alta tu contabilidad.</h1>
      <Burbuja />
      <div className="ob-roles">
        <button type="button" className={cn("ob-role", elegido === "despacho" && "on")} onClick={(e) => elegir("despacho", e.currentTarget)}>
          <Users size={26} strokeWidth={1.8} />
          <b>Llevo varias empresas</b>
          <span>Soy contador o despacho y quiero dar de alta a mis clientes.</span>
        </button>
        <button type="button" className={cn("ob-role", elegido === "empresa" && "on")} onClick={(e) => elegir("empresa", e.currentTarget)}>
          <Building2 size={26} strokeWidth={1.8} />
          <b>Es mi empresa</b>
          <span>Soy dueño o administrador y quiero tener mis números al día.</span>
        </button>
      </div>
    </div>
  );
}

// ── 02 · Personaje ──────────────────────────────────────────────────────────

export function PantallaPersonaje({
  despacho,
  tonoElegido,
  onPiel,
  onTono,
  onListo,
}: {
  despacho: string | null;
  tonoElegido: boolean;
  onPiel: (p: Piel) => void;
  onTono: (t: Tono) => void;
  onListo: () => void;
}) {
  const { decir, festejar, piel, tono, perfil, nombre } = useEscena();
  const [nombreCampo, setNombreCampo] = useState(piel.name ?? "");

  useEffect(() => {
    void decir(despacho ? LINEAS.invitado(despacho, nombre) : LINEAS.personaje);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function elegirPersonaje(id: IdPersonaje) {
    if (piel.char === id) return;
    onPiel({ ...piel, char: id });
    festejar();
    void decir(LINEAS.personajeLinea[id]);
  }

  function elegirTono(id: Tono) {
    if (tono === id) return;
    onTono(id);
    void decir(LINEAS.tono[id]);
  }

  return (
    <div className="ob-cols">
      <div className="ob-lcol">
        <Slot />
        <Burbuja />
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 1 · Tu copiloto</p>
        <h1>Elige cómo quieres que me vea</h1>
        <p className="ob-sub">Sólo cambia mi aspecto: sé lo mismo y trabajo igual. Lo puedes cambiar después desde el chat.</p>
        <div className="ob-chars">
          {IDS_PERSONAJE.map((id) => {
            const c = PERSONAJES[id];
            return (
              <button key={id} type="button" className={cn("ob-char", id === piel.char && "on")} onClick={() => elegirPersonaje(id)}>
                <span className="stage">
                  <PetSkin char={id} color={c.colores[indiceColor(piel, id)][1]} />
                </span>
                <b>{id === piel.char ? nombreDe(piel) : c.label}</b>
                <small>{c.desc}</small>
              </button>
            );
          })}
        </div>
        <div className="ob-row2">
          <div>
            <p className="ob-lbl" style={{ marginBottom: 12 }}>Color</p>
            <div className="ob-sws">
              {PERSONAJES[piel.char].colores.map(([n, v], i) => (
                <button
                  key={n}
                  type="button"
                  className={cn("ob-sw", i === indiceColor(piel) && "on")}
                  onClick={() => onPiel({ ...piel, colors: { ...piel.colors, [piel.char]: i } })}
                >
                  <i style={{ background: v }} />
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="ob-lbl" htmlFor="ob-nombre" style={{ display: "block", marginBottom: 12 }}>
              Nombre
            </label>
            <input
              id="ob-nombre"
              className="ob-field"
              maxLength={MAX_NOMBRE}
              placeholder={PERSONAJES[piel.char].label}
              value={nombreCampo}
              onChange={(e) => {
                setNombreCampo(e.target.value);
                onPiel({ ...piel, name: e.target.value.trim() || null });
              }}
              onBlur={() => nombreCampo.trim() && void decir(LINEAS.nombre(nombreCampo.trim()))}
            />
          </div>
        </div>
        <div className="ob-tone-box">
          <div className="ob-tone-hd">
            <p className="ob-lbl">Cómo te hablo</p>
            <span className="ob-fine">
              {tonoElegido ? "Lo puedes cambiar después" : perfil === "despacho" ? "Sugerido para despachos" : "Sugerido para dueños de empresa"}
            </span>
          </div>
          <div className="ob-tones">
            {TONOS_INFO.map((x) => (
              <button key={x.id} type="button" className={cn("ob-tone", x.id === tono && "on")} onClick={() => elegirTono(x.id)}>
                <span className="ob-tbars">
                  {[1, 2, 3].map((i) => (
                    <i key={i} className={i <= x.barras ? "f" : ""} />
                  ))}
                </span>
                <b>{x.label}</b>
                <small>{x.desc}</small>
              </button>
            ))}
          </div>
          <div className="ob-tprev">
            <span className="ob-tprev-k">Así te explicaría tu IVA</span>
            <p key={tono}>{VISTA_PREVIA_TONO[tono]}</p>
          </div>
        </div>
        <div className="ob-acts">
          <button type="button" className="ob-btn p" onClick={onListo}>
            Así me gusta
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 03 · Confianza ──────────────────────────────────────────────────────────

const PROMESAS = [
  { icon: Eye, titulo: "Sólo leo del SAT", texto: "Descargo tus facturas y declaraciones. Nunca presento nada ni timbro sin que tú lo confirmes." },
  { icon: RotateCcw, titulo: "Nada de lo que hago es destructivo", texto: "Cada ajuste se puede deshacer. Tus libros se regeneran a partir de tus facturas; nunca borro información." },
  { icon: MessageSquare, titulo: "Te cuento qué hice y por qué", texto: "Lo que es obvio lo resuelvo y te lo muestro. Lo que es dudoso te lo pregunto con mi recomendación." },
  { icon: Lock, titulo: "Tu e.firma se guarda cifrada", texto: "La uso sólo para descargar del SAT. La puedes revocar cuando quieras desde Configuración." },
];

export function PantallaConfianza({ onListo }: { onListo: () => void }) {
  const { decir, mirar, tono, reducir } = useEscena();
  const [vistas, setVistas] = useState(0);
  const [hi, setHi] = useState(-1);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      await decir(t(LINEAS.confianza, tono));
      await espera(500, reducir);
      for (let i = 0; i < PROMESAS.length; i++) {
        if (!vivo) return;
        setVistas(i + 1);
        setHi(i);
        mirar(refs.current[i]);
        await espera(1300, reducir);
      }
      if (!vivo) return;
      setHi(-1);
      mirar(null);
      void decir(LINEAS.confianzaFin);
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ob-cols">
      <div className="ob-lcol">
        <Slot />
        <Burbuja />
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 2 · Antes de pedirte nada</p>
        <h1>Esto es lo que voy a hacer, y lo que no</h1>
        <div className="ob-proms">
          {PROMESAS.map(({ icon: Icon, titulo, texto }, i) => (
            <div
              key={titulo}
              ref={(n) => {
                refs.current[i] = n;
              }}
              className={cn("ob-prom", i < vistas && "in", i === hi && "hi")}
            >
              <span className="ic">
                <Icon size={20} />
              </span>
              <div>
                <b>{titulo}</b>
                <p>{texto}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="ob-acts">
          <button type="button" className="ob-btn p" disabled={vistas < PROMESAS.length || hi !== -1} onClick={onListo}>
            Entendido, sigamos
          </button>
        </div>
      </div>
    </div>
  );
}
