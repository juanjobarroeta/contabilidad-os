"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LA MASCOTA DEL COPILOTO — la entrada al chat que te acompaña en cada página.
//
//   · Clic (o Enter/Espacio): abre o cierra el chat.
//   · Arrastrar y soltar sobre un elemento con `data-copiloto`: te lo explica
//     en una burbuja (≤2 frases + la acción que le toca + «Preguntar más»).
//   · Al cambiar de pantalla: UNA pista por ruta y sesión, si el rail tiene
//     algo que necesita de ti. En modo «Botón fijo» se enciende el punto.
//
// La posición y el modo viven en localStorage (`cos-pet-pos`, `cos-pet-mode`).
// Lo que se ESCRIBE nunca pasa por aquí: los botones mandan turnos al chat, y
// el chat propone y espera el tap de confirmación.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { acotarMascota, colocarJunto, esquinaMascota, miradaPupila, TAM_MASCOTA, type Caja } from "@/lib/copiloto/colocar";
import { leerObjetivo, objetivoDesde, objetivoEn } from "@/lib/copiloto/objetivos";
import { tituloDeRuta } from "@/lib/copiloto/sugerencias";
import type { Accion, RefCopiloto } from "@/lib/copiloto/tarjetas";
import type { PedidoRail } from "@/lib/rail/armar";
import { useModoMascota, usePielMascota } from "./useRailCopiloto";
import { PetSkin } from "./PetSkin";
import { colorDe, nombreDe, PERSONAJES } from "@/lib/copiloto/personajes";
import { cn } from "@/lib/utils";

const LLAVE_POS = "cos-pet-pos";
const TAM_CLASICO = 54;
const ESQUINA_CLASICO = 26;
const MS_PISTA = 5200;
const MS_ESPERA_EXPLICACION = 1500;

interface BotonBurbuja {
  label: string;
  primario?: boolean;
  onClick: () => void;
}
interface Burbuja {
  titulo?: string;
  texto: string | null; // null = escribiendo…
  acciones?: BotonBurbuja[];
}

/**
 * La esquina de casa, por encima de la barra de inicio del iPhone (PWA
 * instalada): `env(safe-area-inset-bottom)` sólo se lee desde CSS, así que se
 * mide con un elemento de prueba.
 */
function esquinaSegura(): { x: number; y: number } {
  const p = esquinaMascota(window.innerWidth, window.innerHeight);
  const sonda = document.createElement("div");
  sonda.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(sonda);
  const seguro = parseFloat(getComputedStyle(sonda).paddingBottom) || 0;
  sonda.remove();
  return { x: p.x, y: p.y - seguro };
}

/** ¿El color del personaje es claro? (luminosidad OKLCH ≥ 0.8). */
function colorClaro(c: string): boolean {
  const m = /oklch\(\s*([\d.]+)/.exec(c);
  return m ? Number(m[1]) >= 0.8 : false;
}

// Pistas ya enseñadas en esta sesión (por ruta). Vive en el módulo: sobrevive
// a los re-montajes del layout pero no a una recarga, que es lo que pide.
const pistasVistas = new Set<string>();

export interface CopilotoMascotaProps {
  companyId: string;
  abierto: boolean;
  necesito: PedidoRail[];
  onToggle: () => void;
  /** «Preguntar más»: abre el chat con la referencia y manda «Explícame esto». */
  onPreguntarMas: (ref: RefCopiloto) => void;
  /** Un botón de turno de la burbuja (p. ej. «Preparar DIOT»). */
  onTurno: (seed: string, ref?: RefCopiloto) => void;
  /** La caja de la mascota en pantalla, para anclar el panel flotante. */
  onCaja: (caja: Caja) => void;
  /** Sube cuando el chat pide un salto (abrirse desde otro sitio). */
  saltos: number;
  /** Sube cuando el panel pide «mandar a la esquina». */
  aCasa: number;
  /** Al empezar a arrastrar (el chat se cierra para no tapar los objetivos). */
  onArrastre?: () => void;
}

export function CopilotoMascota({
  companyId,
  abierto,
  necesito,
  onToggle,
  onPreguntarMas,
  onTurno,
  onCaja,
  saltos,
  aCasa,
  onArrastre,
}: CopilotoMascotaProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [modo] = useModoMascota();
  const clasico = modo === "classic";
  const [piel] = usePielMascota();
  const nombre = nombreDe(piel);
  const color = colorDe(piel);
  const miradaRef = useRef(PERSONAJES[piel.char].mirada);
  miradaRef.current = PERSONAJES[piel.char].mirada;

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [sobreObjetivo, setSobreObjetivo] = useState(false);
  const [burbuja, setBurbuja] = useState<Burbuja | null>(null);
  const [cajaBurbuja, setCajaBurbuja] = useState<{ x: number; y: number } | null>(null);
  const [novedad, setNovedad] = useState(false);
  const [salto, setSalto] = useState(0);

  const petRef = useRef<HTMLDivElement>(null);
  const burbujaRef = useRef<HTMLDivElement>(null);
  const pupilas = useRef<(HTMLElement | null)[]>([]);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; movido: boolean } | null>(null);
  const objetivo = useRef<HTMLElement | null>(null);
  const fijado = useRef<HTMLElement | null>(null);
  const ultimoSobre = useRef<HTMLElement | null>(null);
  const finArrastre = useRef(0);
  const timerBurbuja = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peticion = useRef(0);
  const posRef = useRef(pos);
  posRef.current = pos;

  // ── Posición ───────────────────────────────────────────────────────────────

  const colocar = useCallback((x: number, y: number) => {
    setPos(acotarMascota(x, y, window.innerWidth, window.innerHeight));
  }, []);

  const guardar = useCallback((p: { x: number; y: number }) => {
    try {
      localStorage.setItem(LLAVE_POS, JSON.stringify(p));
    } catch {
      /* sin almacenamiento: la posición vale para esta visita */
    }
  }, []);

  useEffect(() => {
    let inicial: { x: number; y: number } | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(LLAVE_POS) ?? "null");
      if (raw && typeof raw.x === "number" && typeof raw.y === "number") inicial = raw;
    } catch {
      /* posición corrupta: a la esquina */
    }
    const p = inicial ?? esquinaSegura();
    colocar(p.x, p.y);
    const onResize = () => {
      const actual = posRef.current;
      if (actual) colocar(actual.x, actual.y);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [colocar]);

  // «↘» desde el panel: de vuelta a la esquina, con salto.
  useEffect(() => {
    if (!aCasa) return;
    const p = esquinaSegura();
    colocar(p.x, p.y);
    guardar(p);
    setSalto((s) => s + 1);
  }, [aCasa, colocar, guardar]);

  useEffect(() => {
    if (saltos) setSalto((s) => s + 1);
  }, [saltos]);

  // Cambiar de personaje: un salto, para que se note quién llegó.
  const charPrevio = useRef(piel.char);
  useEffect(() => {
    if (charPrevio.current !== piel.char) setSalto((s) => s + 1);
    charPrevio.current = piel.char;
  }, [piel.char]);

  // La caja que se le pasa al panel: la de la mascota visible (o la del botón fijo).
  const caja: Caja | null = clasico
    ? typeof window === "undefined"
      ? null
      : {
          left: window.innerWidth - TAM_CLASICO - ESQUINA_CLASICO,
          top: window.innerHeight - TAM_CLASICO - ESQUINA_CLASICO,
          width: TAM_CLASICO,
          height: TAM_CLASICO,
        }
    : pos
      ? { left: pos.x, top: pos.y, width: TAM_MASCOTA, height: TAM_MASCOTA }
      : null;
  const cajaKey = caja ? `${caja.left}|${caja.top}|${caja.width}` : "";
  useEffect(() => {
    if (caja) onCaja(caja);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cajaKey, onCaja]);

  // ── Burbuja ────────────────────────────────────────────────────────────────

  const soltarFijado = useCallback(() => {
    fijado.current?.classList.remove("copiloto-fijado");
    fijado.current = null;
  }, []);

  const ocultarBurbuja = useCallback(() => {
    if (timerBurbuja.current) clearTimeout(timerBurbuja.current);
    peticion.current++;
    setBurbuja(null);
    soltarFijado();
  }, [soltarFijado]);

  const decir = useCallback((b: Burbuja, ms?: number) => {
    if (timerBurbuja.current) clearTimeout(timerBurbuja.current);
    setBurbuja(b);
    setSalto((s) => s + 1);
    if (ms) timerBurbuja.current = setTimeout(() => setBurbuja(null), ms);
  }, []);

  // Colocar la burbuja cuando ya se midió.
  useEffect(() => {
    if (!burbuja || !caja || !burbujaRef.current) {
      setCajaBurbuja(null);
      return;
    }
    const el = burbujaRef.current;
    setCajaBurbuja(colocarJunto(caja, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, "burbuja"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burbuja, cajaKey]);

  // Abrir el chat cierra la burbuja y apaga el punto.
  useEffect(() => {
    if (abierto) {
      ocultarBurbuja();
      setNovedad(false);
    }
  }, [abierto, ocultarBurbuja]);

  // Clic fuera y Esc cierran la burbuja.
  useEffect(() => {
    if (!burbuja) return;
    const fuera = (e: PointerEvent) => {
      const t = e.target as Node;
      if (burbujaRef.current?.contains(t) || petRef.current?.contains(t)) return;
      ocultarBurbuja();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && ocultarBurbuja();
    document.addEventListener("pointerdown", fuera);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", fuera);
      document.removeEventListener("keydown", esc);
    };
  }, [burbuja, ocultarBurbuja]);

  // ── Explicar un elemento ───────────────────────────────────────────────────

  const explicar = useCallback(
    async (el: HTMLElement) => {
      const ref = leerObjetivo(el, pathname);
      if (!ref) return;
      // El recorrido del alta escucha esto para su paso práctico (arrastre o ⌘/).
      window.dispatchEvent(new CustomEvent("cos:copiloto-explica", { detail: { el } }));
      soltarFijado();
      fijado.current = el;
      el.classList.add("copiloto-fijado");

      const id = ++peticion.current;
      const espera = setTimeout(() => {
        if (peticion.current === id) decir({ titulo: ref.titulo, texto: null });
      }, MS_ESPERA_EXPLICACION);

      let explicacion = "";
      let acciones: Accion[] = [];
      try {
        const res = await fetch("/api/ai/explicar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, ref, ruta: pathname }),
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j) {
          explicacion = typeof j.explicacion === "string" ? j.explicacion : "";
          acciones = Array.isArray(j.acciones) ? j.acciones : [];
        } else if (j?.error) {
          explicacion = j.error;
        }
      } catch {
        /* sin red: el usuario aún puede preguntar en el chat */
      }
      clearTimeout(espera);
      if (peticion.current !== id) return;

      const botones: BotonBurbuja[] = [];
      const principal = acciones.find((a) => a.kind === "turno" || a.kind === "navegar");
      if (principal) {
        botones.push({
          label: principal.label,
          primario: true,
          onClick: () => {
            ocultarBurbuja();
            if (principal.kind === "navegar" && principal.href) router.push(principal.href);
            else if (principal.seed) onTurno(principal.seed, ref);
          },
        });
      }
      botones.push({
        label: "Preguntar más",
        primario: !principal,
        onClick: () => {
          ocultarBurbuja();
          onPreguntarMas(ref);
        },
      });
      decir({
        titulo: ref.titulo,
        texto: explicacion || `Esto es «${ref.titulo}». Pregúntame más y lo reviso con tus datos.`,
        acciones: botones,
      });
    },
    [companyId, pathname, decir, ocultarBurbuja, onPreguntarMas, onTurno, router, soltarFijado],
  );

  // ⌘/ (o Ctrl+/): «Preguntar al copiloto sobre esto» para quien usa teclado.
  // Toma el elemento enfocado o, si no hay, el último bajo el puntero.
  useEffect(() => {
    const sobre = (e: PointerEvent) => {
      const el = objetivoDesde(e.target as Element);
      if (el) ultimoSobre.current = el;
    };
    const tecla = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "/") return;
      const el = objetivoDesde(document.activeElement) ?? ultimoSobre.current;
      if (!el || !document.contains(el)) return;
      e.preventDefault();
      void explicar(el);
    };
    document.addEventListener("pointerover", sobre);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("pointerover", sobre);
      document.removeEventListener("keydown", tecla);
    };
  }, [explicar]);

  // ── Arrastre ───────────────────────────────────────────────────────────────

  const quitarObjetivo = () => {
    objetivo.current?.classList.remove("copiloto-objetivo");
    objetivo.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = posRef.current ?? { x: 0, y: 0 };
    drag.current = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, movido: false };
    e.preventDefault();
  };

  useEffect(() => {
    const mover = (e: PointerEvent) => {
      // Los ojos siguen al cursor (sin re-render: van directo al DOM).
      if (!clasico && petRef.current) {
        const r = petRef.current.getBoundingClientRect();
        const { dx, dy } = miradaPupila(r.left + r.width / 2, r.top + r.height / 2, e.clientX, e.clientY);
        const k = miradaRef.current;
        for (const p of pupilas.current) if (p) p.style.transform = `translate(${dx * k}px,${dy * k}px)`;
      }
      const d = drag.current;
      if (!d || clasico) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.movido && Math.hypot(dx, dy) > 4) {
        d.movido = true;
        setArrastrando(true);
        ocultarBurbuja();
        onArrastre?.();
      }
      if (!d.movido) return;
      colocar(d.ox + dx, d.oy + dy);
      const n = objetivoEn(e.clientX, e.clientY);
      if (n !== objetivo.current) {
        quitarObjetivo();
        if (n) {
          objetivo.current = n;
          n.classList.add("copiloto-objetivo");
        }
        setSobreObjetivo(!!n);
      }
    };
    const soltar = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      // Sin arrastre es un clic, y el clic lo atiende onClick: si abriéramos
      // aquí, en táctil el `click` que el navegador dispara después del
      // pointerup cae sobre el fondo del cajón recién pintado y lo cierra.
      if (!d.movido) return;
      finArrastre.current = Date.now();
      setArrastrando(false);
      setSobreObjetivo(false);
      const actual = posRef.current;
      if (actual) guardar(actual);
      const t = objetivo.current;
      quitarObjetivo();
      if (t) void explicar(t);
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
    window.addEventListener("pointercancel", soltar);
    return () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", soltar);
    };
  }, [clasico, colocar, explicar, guardar, ocultarBurbuja, onToggle, onArrastre]);

  // ── Pista al llegar a una pantalla ─────────────────────────────────────────

  const pista = necesito[0];
  useEffect(() => {
    ocultarBurbuja();
    if (!pista || abierto) return;
    const ruta = pathname.split("?")[0];
    const llave = `${companyId}|${ruta}`;
    if (pistasVistas.has(llave)) return;
    pistasVistas.add(llave);
    if (clasico) {
      setNovedad(true);
      return;
    }
    const t = setTimeout(() => {
      decir(
        {
          titulo: "Necesito algo de ti",
          texto: `${pista.titulo}. ${pista.detalle}`,
          acciones: [
            ...(pista.href
              ? [{ label: "Resolver", primario: true, onClick: () => { ocultarBurbuja(); router.push(pista.href!); } }]
              : []),
            {
              label: "Preguntar",
              primario: !pista.href,
              onClick: () => {
                ocultarBurbuja();
                onTurno(`Ayúdame con esto: ${pista.titulo}. ${pista.detalle}`);
              },
            },
          ],
        },
        MS_PISTA,
      );
    }, 260);
    return () => clearTimeout(t);
    // Sólo al cambiar de ruta o de empresa (o cuando llega el rail).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, companyId, pista?.id, clasico]);

  // ── Salto (hop) ────────────────────────────────────────────────────────────
  const [saltando, setSaltando] = useState(false);
  useEffect(() => {
    if (!salto) return;
    setSaltando(false);
    const r = requestAnimationFrame(() => setSaltando(true));
    const t = setTimeout(() => setSaltando(false), 520);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [salto]);

  if (!pos && !clasico) return null;

  const estilo: React.CSSProperties = clasico
    ? { right: ESQUINA_CLASICO, bottom: ESQUINA_CLASICO }
    : { left: pos!.x, top: pos!.y, pointerEvents: arrastrando ? "none" : undefined };

  return (
    <>
      <div
        ref={petRef}
        role="button"
        tabIndex={0}
        aria-label={
          clasico
            ? `${nombre} — tu copiloto. Haz clic para abrir el chat`
            : `${nombre} — tu copiloto. Arrástrame sobre un dato o haz clic para abrir el chat`
        }
        aria-expanded={abierto}
        title={`${nombre} · ${tituloDeRuta(pathname)}`}
        className={cn(
          "cos-pet print:hidden",
          clasico && "classic",
          arrastrando && "drag",
          sobreObjetivo && "over",
          saltando && !clasico && "hop",
          novedad && "news",
        )}
        style={estilo}
        onPointerDown={clasico ? undefined : onPointerDown}
        onClick={() => {
          // Un clic que llega justo al soltar un arrastre no es un clic.
          if (Date.now() - finArrastre.current < 300) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <PetSkin
          char={piel.char}
          color={color}
          className="cos-pet-body"
          pupilaRef={(lado) => (n) => {
            pupilas.current[lado] = n;
          }}
        />
        {clasico && (
          <span
            className={cn(
              "absolute inset-0 grid place-items-center",
              // Crema y Nieve son claros: el ícono blanco se perdería.
              colorClaro(color) ? "text-[oklch(0.22_0.02_258)]" : "text-white",
            )}
          >
            <Sparkles className="h-6 w-6" />
          </span>
        )}
        <span className="cos-pet-dot" />
      </div>

      <div
        ref={burbujaRef}
        aria-live="polite"
        className={cn(
          "cos-pet-bubble fixed z-[61] max-w-[290px] rounded-[14px] border border-cos-line bg-cos-card px-3.5 py-3 text-[13.5px] leading-normal text-cos-ink shadow-[0_14px_34px_-14px_oklch(0.25_0.06_258/0.4)] print:hidden",
          burbuja && cajaBurbuja && "show",
        )}
        style={cajaBurbuja ? { left: cajaBurbuja.x, top: cajaBurbuja.y } : { left: -9999, top: -9999 }}
      >
        {burbuja && (
          <>
            {burbuja.titulo && (
              <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-cos-brand-ink">
                {burbuja.titulo}
              </div>
            )}
            {burbuja.texto === null ? (
              <div className="cos-typing flex gap-1 py-1">
                <i /> <i /> <i />
              </div>
            ) : (
              <div>{burbuja.texto}</div>
            )}
            {burbuja.acciones && burbuja.acciones.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {burbuja.acciones.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={a.onClick}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold",
                      a.primario
                        ? "border-cos-brand bg-cos-brand text-white hover:bg-cos-brand-deep"
                        : "border-cos-line text-cos-ink-soft hover:bg-cos-paper",
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
