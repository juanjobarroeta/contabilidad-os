"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LA ESCENA DEL ALTA — la mascota que viaja entre pantallas y su burbuja.
//
// Una sola mascota (la misma piel del copiloto, <PetSkin>) fija en la página:
// cada pantalla marca dónde va con `data-ob-slot` y la mascota se desliza
// hasta ahí (.9 s). Las pantallas le hablan con `decir()` (la burbuja escribe
// a ~2 caracteres cada 20 ms; un clic la completa), la hacen festejar con
// `festejar()` y le dicen qué mirar con `mirar()`.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Piel } from "@/lib/copiloto/personajes";
import { colorDe, nombreDe } from "@/lib/copiloto/personajes";
import { miradaPupila } from "@/lib/copiloto/colocar";
import type { Perfil, Tono } from "@/lib/onboarding/progreso";
import { PetSkin } from "@/components/ai/PetSkin";
import { cn } from "@/lib/utils";

export interface Escena {
  tono: Tono;
  perfil: Perfil | null;
  reducir: boolean;
  piel: Piel;
  nombre: string;
  /** Lo que dice la burbuja de la pantalla actual. */
  linea: { html: string; id: number };
  decir: (html: string) => Promise<void>;
  festejar: () => void;
  feliz: (on: boolean) => void;
  /** null = vuelve a seguir el cursor. */
  mirar: (el: Element | null) => void;
  /** Lleva la mascota al `data-ob-slot` de la pantalla. */
  aSlot: () => void;
  /** Encima de un elemento (p.ej. el mes que se está pidiendo). */
  sobre: (el: Element, escala?: number) => void;
}

const Ctx = createContext<Escena | null>(null);

export function useEscena(): Escena {
  const e = useContext(Ctx);
  if (!e) throw new Error("useEscena fuera de <EscenaProvider>");
  return e;
}

const TAM = 58;
const MS_POR_PASO = 20;
const CHARS_POR_PASO = 2;

function textoPlano(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent ?? "";
}

export function EscenaProvider({
  tono,
  perfil,
  reducir,
  piel,
  anillo,
  children,
}: {
  tono: Tono;
  perfil: Perfil | null;
  reducir: boolean;
  piel: Piel;
  /** 0..1 del historial; null = sin anillo. */
  anillo: number | null;
  children: ReactNode;
}) {
  const petRef = useRef<HTMLDivElement>(null);
  const pupilas = useRef<(HTMLElement | null)[]>([null, null]);
  const pos = useRef({ x: 0, y: 0, s: 1 });
  const mirando = useRef<Element | null>(null);
  const [linea, setLinea] = useState({ html: "", id: 0 });
  const [clases, setClases] = useState({ hop: false, cheer: false, happy: false });
  const reducirRef = useRef(reducir);
  reducirRef.current = reducir;

  const colocar = useCallback((x: number, y: number, s: number, rapido = false) => {
    const el = petRef.current;
    if (!el) return;
    pos.current = { x, y, s };
    el.classList.toggle("fast", rapido);
    el.style.transform = `translate(${x - TAM / 2}px, ${y - TAM / 2}px) scale(${s})`;
  }, []);

  const mirarPunto = useCallback((x: number, y: number) => {
    const { dx, dy } = miradaPupila(pos.current.x, pos.current.y, x, y);
    for (const p of pupilas.current) if (p) p.style.transform = `translate(${dx}px, ${dy}px)`;
  }, []);

  const mirar = useCallback(
    (el: Element | null) => {
      mirando.current = el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      mirarPunto(r.left + r.width / 2, r.top + r.height / 2);
    },
    [mirarPunto],
  );

  const aSlot = useCallback(() => {
    const sl = document.querySelector<HTMLElement>(".ob-scr [data-ob-slot]");
    if (!sl) return;
    const r = sl.getBoundingClientRect();
    const base = Number(sl.dataset.obSlot) || 2;
    colocar(r.left + r.width / 2, r.top + r.height / 2, Math.max(0.8, (base * r.width) / 140));
  }, [colocar]);

  const sobre = useCallback(
    (el: Element, escala = 0.55) => {
      const r = el.getBoundingClientRect();
      colocar(r.left + r.width / 2, r.top - 20, escala, true);
      mirar(el);
    },
    [colocar, mirar],
  );

  const pulso = useCallback((k: "hop" | "cheer", ms: number) => {
    setClases((c) => ({ ...c, [k]: false }));
    requestAnimationFrame(() => setClases((c) => ({ ...c, [k]: true })));
    setTimeout(() => setClases((c) => ({ ...c, [k]: false })), ms);
  }, []);

  const decir = useCallback(
    (html: string) => {
      setLinea((l) => ({ html, id: l.id + 1 }));
      pulso("hop", 520);
      const ms = reducirRef.current ? 0 : Math.ceil(textoPlano(html).length / CHARS_POR_PASO) * MS_POR_PASO;
      return new Promise<void>((res) => setTimeout(res, ms + 40));
    },
    [pulso],
  );

  const festejar = useCallback(() => pulso("cheer", 950), [pulso]);
  const feliz = useCallback((on: boolean) => setClases((c) => ({ ...c, happy: on })), []);

  // Entrada: desde abajo y chiquita. En layout effect —antes de que la
  // pantalla (efecto normal) la mande a su slot— para que el viaje se anime.
  useLayoutEffect(() => {
    const el = petRef.current;
    if (!el) return;
    el.classList.add("nomove");
    colocar(window.innerWidth / 2, window.innerHeight + 120, 0.4);
    void el.offsetWidth;
    el.classList.remove("nomove");
  }, [colocar]);

  // Los ojos siguen al cursor cuando no hay nada que mirar.
  useEffect(() => {
    const mover = (e: PointerEvent) => {
      if (!mirando.current) mirarPunto(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", mover);
    return () => window.removeEventListener("pointermove", mover);
  }, [mirarPunto]);

  const nombre = nombreDe(piel);
  const valor: Escena = { tono, perfil, reducir, piel, nombre, linea, decir, festejar, feliz, mirar, aSlot, sobre };

  return (
    <Ctx.Provider value={valor}>
      {children}
      <div
        ref={petRef}
        role="img"
        aria-label={`${nombre}, tu copiloto`}
        className={cn("cos-pet ob-pet", clases.hop && "hop", clases.cheer && "cheer", clases.happy && "happy")}
      >
        <PetSkin
          char={piel.char}
          color={colorDe(piel)}
          className="cos-pet-body"
          pupilaRef={(lado) => (n) => {
            pupilas.current[lado] = n;
          }}
        />
        {anillo != null && (
          <svg className="ob-ring" viewBox="0 0 76 76" aria-hidden>
            <circle className="bg" cx="38" cy="38" r="35" />
            <circle className="fg" cx="38" cy="38" r="35" strokeDasharray="220" strokeDashoffset={220 - 220 * anillo} />
          </svg>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** La burbuja de la pantalla: escribe la línea actual; un clic la completa. */
export function Burbuja({ className }: { className?: string }) {
  const { linea, reducir } = useEscena();
  const [n, setN] = useState<number | null>(null);
  const plano = useRef("");

  useEffect(() => {
    plano.current = textoPlano(linea.html);
    if (reducir || !linea.html) {
      setN(null);
      return;
    }
    setN(0);
    const t = setInterval(() => {
      setN((k) => {
        const sig = (k ?? 0) + CHARS_POR_PASO;
        if (sig >= plano.current.length) {
          clearInterval(t);
          return null;
        }
        return sig;
      });
    }, MS_POR_PASO);
    return () => clearInterval(t);
  }, [linea.id, linea.html, reducir]);

  return (
    <div className={cn("ob-say", className)} aria-live="polite" onClick={() => setN(null)}>
      {n == null ? (
        <span dangerouslySetInnerHTML={{ __html: linea.html }} />
      ) : (
        <>
          {plano.current.slice(0, n)}
          <span className="ob-caret" />
        </>
      )}
    </div>
  );
}

/** Dónde se para la mascota en esta pantalla. */
export function Slot({ escala = 2, className }: { escala?: number; className?: string }) {
  return <div className={cn("ob-slot", className)} data-ob-slot={escala} aria-hidden />;
}
