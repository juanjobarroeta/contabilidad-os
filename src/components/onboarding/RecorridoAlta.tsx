"use client";

// ─────────────────────────────────────────────────────────────────────────────
// 08 · RECORRIDO + DESCARGA LA APP — el final del alta, dentro de la app real.
//
// Se activa con /dashboard?recorrido=1 (o la marca `cos-recorrido` si se
// recargó). Resalta cada sección del menú, el buscador y el copiloto
// (src/lib/onboarding/recorrido.ts); el paso práctico avanza cuando la
// mascota real explica la tarjeta resaltada (evento `cos:copiloto-explica`,
// por arrastre o ⌘/). Al terminar ofrece instalar la app (PWA): diálogo nativo
// donde existe, instrucciones en iOS y un QR para abrirla en el celular.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Download, MoreVertical, Plus, Share, Smartphone } from "lucide-react";
import { PetSkin } from "@/components/ai/PetSkin";
import { usePielMascota } from "@/components/ai/useRailCopiloto";
import { colorDe, nombreDe } from "@/lib/copiloto/personajes";
import { LINEAS, t } from "@/lib/onboarding/lineas";
import { PASOS_RECORRIDO, type PasoRecorrido } from "@/lib/onboarding/recorrido";
import { sanearProgreso, type Tono } from "@/lib/onboarding/progreso";
import { esIos, esMovil, esStandalone, instalar, LLAVE_RECORRIDO, puedeInstalar, suscribirInstalacion } from "@/lib/pwa/instalacion";
import { cn } from "@/lib/utils";

type Fase = "tour" | "app" | null;
interface Caja {
  left: number;
  top: number;
  width: number;
  height: number;
}

const ANCHO_TIP = 320;

function visible(el: Element): Caja | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function buscar(selector: string): Element | null {
  const todos = Array.from(document.querySelectorAll(selector));
  return todos.find((el) => visible(el)) ?? todos[0] ?? null;
}

function guardarPaso(paso: "app" | "listo") {
  void fetch("/api/onboarding/progreso", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paso }),
  }).catch(() => {});
}

export function RecorridoAlta() {
  const pathname = usePathname();
  const router = useRouter();
  const [fase, setFase] = useState<Fase>(null);
  const [tono, setTono] = useState<Tono>("bal");
  const [pasos, setPasos] = useState<PasoRecorrido[]>([]);
  const [i, setI] = useState(0);
  const [caja, setCaja] = useState<Caja | null>(null);
  const [linea, setLinea] = useState("");
  const [practicoHecho, setPracticoHecho] = useState(false);
  const objetivo = useRef<Element | null>(null);

  // ¿Toca? Por la URL o por la marca local; el progreso dice si ya va en «app».
  useEffect(() => {
    let marca = false;
    try {
      marca = localStorage.getItem(LLAVE_RECORRIDO) === "1";
    } catch {
      /* modo privado */
    }
    const porUrl = new URLSearchParams(window.location.search).get("recorrido") === "1";
    if (!marca && !porUrl) return;
    let vivo = true;
    (async () => {
      const r = await fetch("/api/onboarding/progreso").catch(() => null);
      const p = r?.ok ? sanearProgreso((await r.json()).progreso) : null;
      if (!vivo) return;
      if (p) setTono(p.tono);
      if (p?.paso === "listo") {
        terminarLocal();
        return;
      }
      if (p?.paso === "app") {
        setFase("app");
        return;
      }
      // Que la app termine de pintar (menú, tarjetas) antes de buscar objetivos.
      setTimeout(() => {
        if (!vivo) return;
        const presentes = PASOS_RECORRIDO.filter((x) => x.siFalta === "centrar" || document.querySelector(x.selector));
        setPasos(presentes);
        setI(0);
        setFase("tour");
      }, 1200);
    })();
    return () => {
      vivo = false;
    };
    // Sólo al montar la app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paso = fase === "tour" ? pasos[i] : undefined;

  const medir = useCallback(() => {
    if (!paso) return;
    const el = buscar(paso.selector);
    objetivo.current = el;
    if (el && !visible(el)) el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setCaja(el ? visible(el) : null);
  }, [paso]);

  useEffect(() => {
    if (!paso) return;
    setPracticoHecho(false);
    setLinea(t(paso.linea, tono));
    medir();
    const t1 = setTimeout(medir, 450);
    window.addEventListener("resize", medir);
    window.addEventListener("scroll", medir, true);
    return () => {
      clearTimeout(t1);
      window.removeEventListener("resize", medir);
      window.removeEventListener("scroll", medir, true);
    };
  }, [paso, tono, medir]);

  // Paso práctico: la mascota real explicó algo.
  useEffect(() => {
    if (paso?.practico !== "arrastre") return;
    const on = (e: Event) => {
      const el = (e as CustomEvent<{ el: Element }>).detail?.el;
      const obj = objetivo.current;
      if (el && obj && (obj === el || obj.contains(el) || el.contains(obj))) {
        setPracticoHecho(true);
        setLinea(t(LINEAS.arrastreBien, tono));
      } else {
        setLinea(LINEAS.arrastreFallido);
      }
    };
    window.addEventListener("cos:copiloto-explica", on);
    return () => window.removeEventListener("cos:copiloto-explica", on);
  }, [paso, tono]);

  // La mascota en «botón fijo» no se arrastra: el paso práctico no bloquea.
  const sinArrastre = paso?.practico === "arrastre" && typeof document !== "undefined" && !!document.querySelector(".cos-pet.classic");
  const puedeSeguir = paso?.practico !== "arrastre" || practicoHecho || sinArrastre;

  const siguiente = useCallback(() => {
    if (i + 1 < pasos.length) setI(i + 1);
    else {
      setFase("app");
      guardarPaso("app");
    }
  }, [i, pasos.length]);

  const saltar = () => {
    setFase("app");
    guardarPaso("app");
  };

  function terminarLocal() {
    try {
      localStorage.removeItem(LLAVE_RECORRIDO);
    } catch {
      /* nada */
    }
    setFase(null);
    if (new URLSearchParams(window.location.search).get("recorrido")) router.replace(pathname);
  }

  function terminar() {
    guardarPaso("listo");
    terminarLocal();
  }

  // Teclado: Enter sigue (o, en el paso práctico, cuenta como soltar sobre la tarjeta); Esc salta.
  useEffect(() => {
    if (fase !== "tour") return;
    const k = (e: KeyboardEvent) => {
      const enCampo = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
      if (enCampo) return;
      if (e.key === "Escape") saltar();
      if (e.key === "Enter" && puedeSeguir && !(e.target as HTMLElement)?.closest?.("button, a")) {
        e.preventDefault();
        siguiente();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fase, puedeSeguir, siguiente]);

  if (fase === "app") return <DescargaApp onListo={terminar} />;
  if (fase !== "tour" || !paso) return null;
  return (
    <Spotlight
      caja={caja}
      paso={paso}
      n={i + 1}
      total={pasos.length}
      linea={linea}
      puedeSeguir={puedeSeguir}
      ultimo={i + 1 === pasos.length}
      onSiguiente={siguiente}
      onSaltar={saltar}
    />
  );
}

function Spotlight({
  caja,
  paso,
  n,
  total,
  linea,
  puedeSeguir,
  ultimo,
  onSiguiente,
  onSaltar,
}: {
  caja: Caja | null;
  paso: PasoRecorrido;
  n: number;
  total: number;
  linea: string;
  puedeSeguir: boolean;
  ultimo: boolean;
  onSiguiente: () => void;
  onSaltar: () => void;
}) {
  const [piel] = usePielMascota();
  const tipRef = useRef<HTMLDivElement>(null);
  const [alto, setAlto] = useState(180);
  useEffect(() => {
    if (tipRef.current) setAlto(tipRef.current.offsetHeight);
  }, [linea, puedeSeguir]);

  const pos = useMemo(() => {
    const W = typeof window !== "undefined" ? window.innerWidth : 1280;
    const H = typeof window !== "undefined" ? window.innerHeight : 800;
    const w = Math.min(ANCHO_TIP, W - 32);
    if (!caja) return { left: (W - w) / 2, top: Math.max(16, (H - alto) / 2), w };
    const r = { right: caja.left + caja.width, bottom: caja.top + caja.height };
    if (r.right + 36 + w < W - 16) return { left: r.right + 36, top: Math.max(70, Math.min(H - alto - 16, caja.top)), w };
    const left = Math.max(16, Math.min(W - w - 16, caja.left));
    let top = r.bottom + 48;
    if (top + alto > H - 16) top = Math.max(16, caja.top - alto - 48);
    return { left, top, w };
  }, [caja, alto]);

  return (
    <>
      <div
        className="cos-spot"
        aria-hidden
        style={
          caja
            ? { left: caja.left - 8, top: caja.top - 8, width: caja.width + 16, height: caja.height + 16 }
            : { left: "50%", top: "50%", width: 0, height: 0 }
        }
      />
      <div
        ref={tipRef}
        role="dialog"
        aria-label={`Recorrido: ${paso.titulo}`}
        className="cos-tip"
        style={{ left: pos.left, top: pos.top, width: pos.w }}
      >
        <span className="absolute -left-4 -top-6 block h-[58px] w-[58px] origin-top-left scale-[.75]" aria-hidden>
          <PetSkin char={piel.char} color={colorDe(piel)} className="cos-tip-pet" />
        </span>
        <p className="pl-8 font-mono text-[11px] font-semibold uppercase tracking-[.12em] text-cos-brand-ink">
          Recorrido · {n} de {total}
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-cos-ink" aria-live="polite" dangerouslySetInnerHTML={{ __html: linea }} />
        <div className="mt-4 flex items-center gap-2">
          <span className="mr-auto font-mono text-[11px] text-cos-ink-faint">{nombreDe(piel)}</span>
          <button type="button" onClick={onSaltar} className="rounded-lg px-3 py-2 text-[13px] font-semibold text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink">
            Saltar recorrido
          </button>
          {puedeSeguir && (
            <button
              type="button"
              autoFocus
              onClick={onSiguiente}
              className="rounded-lg bg-cos-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
            >
              {ultimo ? "Terminar" : "Siguiente"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Descarga la app ─────────────────────────────────────────────────────────

function DescargaApp({ onListo }: { onListo: () => void }) {
  const [piel] = usePielMascota();
  const [instalable, setInstalable] = useState(false);
  const [instalada, setInstalada] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [plataforma, setPlataforma] = useState<"ios" | "android" | "escritorio">("escritorio");

  useEffect(() => {
    setInstalada(esStandalone());
    setPlataforma(esIos() ? "ios" : esMovil() ? "android" : "escritorio");
    const revisar = () => setInstalable(puedeInstalar());
    revisar();
    const quitar = suscribirInstalacion(revisar);
    if (!esMovil()) {
      void import("qrcode").then(({ default: QR }) =>
        QR.toDataURL(`${window.location.origin}/dashboard`, { margin: 1, width: 168, color: { dark: "#1c2433", light: "#ffffff" } })
          .then(setQr)
          .catch(() => setQr(null)),
      );
    }
    return quitar;
  }, []);

  async function pedirInstalar() {
    if (await instalar()) setInstalada(true);
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-[oklch(0.2_0.03_258/.45)] p-4 sm:items-center" role="dialog" aria-modal aria-labelledby="descarga-titulo">
      <div className="relative w-full max-w-[480px] rounded-[22px] border border-cos-line bg-cos-card p-6 shadow-2xl">
        <span className="absolute -top-7 left-6 block h-[58px] w-[58px]" aria-hidden>
          <PetSkin char={piel.char} color={colorDe(piel)} className="cos-tip-pet" />
        </span>
        <p className="mt-5 font-mono text-[11px] font-semibold uppercase tracking-[.12em] text-cos-brand-ink">Tu alta · último paso</p>
        <h2 id="descarga-titulo" className="mt-1 text-[22px] font-semibold tracking-[-.02em] text-cos-ink">
          Descarga la app
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-cos-ink-soft">
          Tenme en tu celular: te aviso antes de cada vencimiento y me preguntas lo que sea desde donde estés. {nombreDe(piel)} viene contigo.
        </p>

        {instalada ? (
          <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-cos-jade-tint px-4 py-3.5 text-sm font-semibold text-cos-jade-ink">
            <Check className="h-[18px] w-[18px]" strokeWidth={2.5} /> Ya la tienes instalada.
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            {instalable && (
              <button
                type="button"
                onClick={() => void pedirInstalar()}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-cos-brand px-4 py-3 text-sm font-semibold text-white hover:bg-cos-brand-deep"
              >
                <Download className="h-4 w-4" /> Instalar ContabilidadOS {plataforma === "escritorio" ? "en esta computadora" : ""}
              </button>
            )}
            {plataforma === "ios" && (
              <ol className="flex flex-col gap-2 rounded-xl border border-cos-line bg-cos-paper px-4 py-3.5 text-sm text-cos-ink-soft">
                <li>
                  1. Toca <Share className="inline h-4 w-4 align-[-3px] text-cos-brand-ink" /> <b className="text-cos-ink">Compartir</b> en Safari.
                </li>
                <li>
                  2. Elige <Plus className="inline h-4 w-4 align-[-3px] text-cos-brand-ink" /> <b className="text-cos-ink">Agregar a inicio</b>.
                </li>
                <li>3. Ábrela desde tu pantalla de inicio, como cualquier app.</li>
              </ol>
            )}
            {plataforma === "android" && !instalable && (
              <p className="rounded-xl border border-cos-line bg-cos-paper px-4 py-3.5 text-sm text-cos-ink-soft">
                Abre el menú <MoreVertical className="inline h-4 w-4 align-[-3px]" /> del navegador y elige{" "}
                <b className="text-cos-ink">Instalar app</b> o <b className="text-cos-ink">Agregar a pantalla de inicio</b>.
              </p>
            )}
            {plataforma === "escritorio" && (
              <div className="flex items-center gap-4 rounded-xl border border-cos-line bg-cos-paper p-4">
                {qr ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr} alt="Código QR para abrir ContabilidadOS en tu celular" width={112} height={112} className="rounded-lg bg-white p-1" />
                ) : (
                  <Smartphone className="h-10 w-10 text-cos-ink-faint" />
                )}
                <div className="text-sm leading-relaxed text-cos-ink-soft">
                  <b className="block text-cos-ink">En tu celular</b>
                  Escanea el código con la cámara, entra con tu cuenta y elige <b className="text-cos-ink">Agregar a inicio</b> (iPhone) o{" "}
                  <b className="text-cos-ink">Instalar app</b> (Android).
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onListo} className="rounded-xl bg-cos-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-cos-brand-deep">
            Listo, ir a mi tablero
          </button>
          {!instalada && (
            <button type="button" onClick={onListo} className={cn("rounded-xl px-4 py-2.5 text-sm font-semibold text-cos-ink-soft hover:bg-cos-paper")}>
              Ahora no
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
