"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING CON MASCOTA (/onboarding) — reemplaza el wizard de formularios.
//
//   01 Bienvenida → 02 Personaje → 03 Confianza → 04 e.firma → 05 Historial
//   → 06 Bancos → 07 Equipo → (en la app) 08 Recorrido → Descarga la app
//
// Modos:
//   · alta     — usuario nuevo. Con invitación de despacho entra en 02.
//   · agregar  — ya tiene empresas (o viene de Configuración → Empresas):
//                sólo 04 → 05 y regresa. Sin bienvenida ni recorrido.
// El progreso vive en User.onboarding: recargar retoma la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { BrandMark } from "@/components/ui/BrandMark";
import { fijarPiel, usePielMascota } from "@/components/ai/useRailCopiloto";
import { rutaRetornoSegura } from "@/lib/ruta-retorno";
import { LLAVE_RECORRIDO } from "@/lib/pwa/instalacion";
import {
  PASOS_ALTA,
  PROGRESO_INICIAL,
  sanearProgreso,
  tonoSugerido,
  type PasoAlta,
  type Perfil,
  type Progreso,
  type Tono,
} from "@/lib/onboarding/progreso";
import { EscenaProvider, useEscena } from "./escena";
import { PantallaConfianza, PantallaHola, PantallaPersonaje } from "./PantallasIntro";
import { PantallaFiel } from "./PantallaFiel";
import { PantallaHistorial } from "./PantallaHistorial";
import { PantallaBancos, PantallaEquipo } from "./PantallasOpcionales";
import { avanceHistorial, type EstadoAlta } from "./tipos";
import { cn } from "@/lib/utils";

interface Contexto {
  invitado: boolean;
  despachoNombre: string | null;
  despachoRol: string | null;
  empresas: number;
}

type Modo = "alta" | "agregar";

const PASOS_AGREGAR: readonly PasoAlta[] = ["fiel", "historial"];

export function OnboardingMascota() {
  const router = useRouter();
  const params = useSearchParams();
  const fromEmpresas = params.get("from") === "empresas";
  const explicitReturn = rutaRetornoSegura(params.get("returnTo"));
  const pagado = params.get("checkout") === "exito";

  const [piel, setPielLocal] = usePielMascota();
  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [progreso, setProgreso] = useState<Progreso>(PROGRESO_INICIAL);
  const [modo, setModo] = useState<Modo | null>(null);
  const [paso, setPaso] = useState<PasoAlta>("hola");
  const [reducir, setReducir] = useState(false);
  const [estado, setEstado] = useState<EstadoAlta | null>(null);

  // Carga: contexto (invitación, empresas) + progreso guardado → modo y pantalla.
  useEffect(() => {
    let vivo = true;
    (async () => {
      const [rc, rp] = await Promise.all([
        fetch("/api/onboarding/contexto").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/onboarding/progreso").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!vivo) return;
      const c: Contexto = {
        invitado: !!rc?.invitado,
        despachoNombre: rc?.despachoNombre ?? null,
        despachoRol: rc?.despachoRol ?? null,
        empresas: Number(rc?.empresas ?? 0),
      };
      const guardado = rp?.progreso ? sanearProgreso(rp.progreso) : null;
      setCtx(c);
      const enCurso = guardado && guardado.companyId && (PASOS_ALTA as readonly string[]).includes(guardado.paso);
      const agregar = fromEmpresas || !!explicitReturn || (c.empresas > 0 && !enCurso);
      if (agregar) {
        setModo("agregar");
        setProgreso({ ...PROGRESO_INICIAL, perfil: guardado?.perfil ?? null, tono: guardado?.tono ?? "bal", tonoElegido: true });
        setPaso("fiel");
        return;
      }
      const p = guardado ?? { ...PROGRESO_INICIAL };
      setProgreso(p);
      setModo("alta");
      let inicio: PasoAlta = (PASOS_ALTA as readonly string[]).includes(p.paso) ? (p.paso as PasoAlta) : "hola";
      // Sin empresa todavía no hay historial que mostrar: de vuelta a la e.firma.
      if (!p.companyId && PASOS_ALTA.indexOf(inicio) > PASOS_ALTA.indexOf("fiel")) inicio = "fiel";
      if (inicio === "hola" && c.invitado) inicio = "personaje";
      setPaso(inicio);
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setReducir(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  const guardar = useCallback(
    (cambio: Partial<Progreso>) => {
      setProgreso((p) => ({ ...p, ...cambio }));
      if (modo !== "alta") return;
      void fetch("/api/onboarding/progreso", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cambio),
      }).catch(() => {});
    },
    [modo],
  );

  const companyId = progreso.companyId;

  // El historial se lee cada 5 s en su pantalla y cada 15 s en las demás
  // (para el chip de la barra y el anillo de la mascota).
  useEffect(() => {
    if (!companyId) return;
    let vivo = true;
    const leer = async () => {
      const r = await fetch(`/api/onboarding/estado?companyId=${encodeURIComponent(companyId)}`).catch(() => null);
      if (!vivo || !r?.ok) return;
      setEstado(await r.json());
    };
    void leer();
    const t = setInterval(leer, paso === "historial" ? 5000 : 15000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [companyId, paso]);

  const pasos = modo === "agregar" ? PASOS_AGREGAR : PASOS_ALTA;
  const successHref = explicitReturn ?? (fromEmpresas ? "/configuracion/empresas" : "/dashboard");

  const ir = useCallback(
    (siguiente: PasoAlta) => {
      setPaso(siguiente);
      guardar({ paso: siguiente });
    },
    [guardar],
  );

  const avanzar = useCallback(() => {
    const i = pasos.indexOf(paso);
    if (i < pasos.length - 1) return ir(pasos[i + 1]);
    // Fin del alta.
    if (modo === "agregar") {
      router.push(successHref);
      router.refresh();
      return;
    }
    guardar({ paso: "recorrido" });
    try {
      localStorage.setItem(LLAVE_RECORRIDO, "1");
    } catch {
      /* sin localStorage: el ?recorrido=1 basta */
    }
    router.push("/dashboard?recorrido=1");
    router.refresh();
  }, [guardar, ir, modo, paso, pasos, router, successHref]);

  function salir() {
    if (companyId || (ctx?.empresas ?? 0) > 0) {
      router.push(modo === "agregar" ? successHref : "/dashboard");
      return;
    }
    void signOut({ callbackUrl: "/login" });
  }

  function cambiarPiel(p: typeof piel) {
    setPielLocal(p);
    fijarPiel(p);
  }

  const elegirPerfil = (p: Perfil) => {
    const cambio: Partial<Progreso> = { perfil: p };
    if (!progreso.tonoElegido) cambio.tono = tonoSugerido(p);
    guardar(cambio);
    ir("personaje");
  };

  const historialEnMarcha = !!companyId && !!estado && estado.resumen.total > 0;
  const avance = avanceHistorial(estado);
  const mostrarChip = historialEnMarcha && paso !== "historial";
  const anillo = mostrarChip && !estado!.resumen.completo ? avance : null;
  const indice = pasos.indexOf(paso);

  const despachoAdmin = ctx?.despachoRol === "OWNER" || ctx?.despachoRol === "ADMIN";

  if (!modo || !ctx) return <div className="ob" />;

  return (
    <div className={cn("ob", reducir && "reduce")}>
      <EscenaProvider tono={progreso.tono} perfil={progreso.perfil} reducir={reducir} piel={piel} anillo={anillo}>
        <header className="ob-top">
          <div className="ob-brand">
            <BrandMark size={22} className="text-cos-brand" />
            <span>
              Contabilidad<span className="os">OS</span>
            </span>
          </div>
          {pasos.length > 2 && (
            <div className="ob-steps" aria-label={`Paso ${indice + 1} de ${pasos.length}`}>
              {pasos.map((p, k) => (
                <span key={p} className={k < indice ? "done" : k === indice ? "on" : ""} />
              ))}
            </div>
          )}
          <div className="ob-tools">
            {mostrarChip && (
              <div className={cn("ob-chip", estado!.resumen.completo && "done")} title="Historial del SAT">
                <i />
                <span>{estado!.resumen.completo ? "Historial completo" : `Historial ${Math.round(avance * 100)}%`}</span>
              </div>
            )}
            <button type="button" className={cn("ob-tbtn hide-sm", reducir && "on")} onClick={() => setReducir((v) => !v)} aria-pressed={reducir}>
              Reducir animación
            </button>
            <button type="button" className="ob-tbtn" onClick={salir}>
              Salir
            </button>
          </div>
        </header>

        <Pantalla key={paso} paso={paso}>
          {paso === "hola" && <PantallaHola pagado={pagado} onPerfil={elegirPerfil} />}
          {paso === "personaje" && (
            <PantallaPersonaje
              despacho={ctx.invitado ? ctx.despachoNombre : null}
              tonoElegido={progreso.tonoElegido}
              onPiel={cambiarPiel}
              onTono={(t: Tono) => guardar({ tono: t, tonoElegido: true })}
              onListo={avanzar}
            />
          )}
          {paso === "confianza" && <PantallaConfianza onListo={avanzar} />}
          {paso === "fiel" && <PantallaFiel onCreada={(id) => guardar({ companyId: id })} onListo={avanzar} />}
          {paso === "historial" && companyId && (
            <PantallaHistorial
              companyId={companyId}
              estado={estado}
              onSeguir={avanzar}
              onCambiarAnios={async (anios) => {
                await fetch("/api/onboarding/estado", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ companyId, anios }),
                }).catch(() => null);
                const r = await fetch(`/api/onboarding/estado?companyId=${encodeURIComponent(companyId)}`).catch(() => null);
                if (r?.ok) setEstado(await r.json());
              }}
            />
          )}
          {paso === "bancos" && companyId && <PantallaBancos companyId={companyId} onSeguir={avanzar} />}
          {paso === "equipo" && companyId && <PantallaEquipo companyId={companyId} despachoAdmin={despachoAdmin} onSeguir={avanzar} />}
        </Pantalla>
      </EscenaProvider>
    </div>
  );
}

/** Contenedor de cada pantalla: al montarse lleva la mascota a su lugar. */
function Pantalla({ paso, children }: { paso: PasoAlta; children: React.ReactNode }) {
  const { aSlot, mirar } = useEscena();
  const ref = useRef<HTMLElement>(null);
  const etiqueta = useMemo(
    () =>
      ({
        hola: "01 Bienvenida",
        personaje: "02 Personaje",
        confianza: "03 Confianza",
        fiel: "04 e.firma",
        historial: "05 Historial",
        bancos: "06 Bancos",
        equipo: "07 Equipo",
      })[paso],
    [paso],
  );

  useEffect(() => {
    mirar(null);
    const r = requestAnimationFrame(() => aSlot());
    const reubicar = () => {
      const pet = document.querySelector<HTMLElement>(".ob-pet");
      pet?.classList.add("nomove");
      aSlot();
      requestAnimationFrame(() => pet?.classList.remove("nomove"));
    };
    window.addEventListener("resize", reubicar);
    const scr = ref.current;
    scr?.addEventListener("scroll", reubicar, { passive: true });
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("resize", reubicar);
      scr?.removeEventListener("scroll", reubicar);
    };
  }, [aSlot, mirar]);

  return (
    <section ref={ref} className="ob-scr" aria-label={etiqueta}>
      {children}
    </section>
  );
}
