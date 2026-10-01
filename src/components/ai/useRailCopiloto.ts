"use client";

import { useEffect, useState } from "react";
import type { PedidoRail, Rail } from "@/lib/rail/armar";
import { PIEL_DEFAULT, sanearPiel, type Piel } from "@/lib/copiloto/personajes";

// El rail del copiloto (lo que hice / lo que necesito / revisiones / cómo
// vamos), compartido por la mascota (pistas), las sugerencias del chat y la
// vista «Resumen». Caché de módulo de un minuto y una sola petición en vuelo
// por empresa: todos lo piden al montar.

export interface RailRespuesta extends Rail {
  resumen: { titulo: string; cuerpo: string; fecha: string } | null;
  informativos: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; rail: RailRespuesta }>();
const enVuelo = new Map<string, Promise<RailRespuesta>>();

function pedir(companyId: string, forzar = false): Promise<RailRespuesta> {
  const hit = cache.get(companyId);
  if (!forzar && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.rail);
  const ya = enVuelo.get(companyId);
  if (ya) return ya;
  const p = fetch(`/api/rail?companyId=${companyId}`)
    .then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error ?? `HTTP ${r.status}`);
      const rail = j as RailRespuesta;
      cache.set(companyId, { at: Date.now(), rail });
      return rail;
    })
    .finally(() => enVuelo.delete(companyId));
  enVuelo.set(companyId, p);
  return p;
}

export function useRail(companyId: string | null | undefined): {
  rail: RailRespuesta | null;
  cargando: boolean;
  error: string | null;
  recargar: () => void;
} {
  const [rail, setRail] = useState<RailRespuesta | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    if (!companyId) {
      setRail(null);
      return;
    }
    let vivo = true;
    setCargando(true);
    setError(null);
    pedir(companyId, intento > 0)
      .then((r) => vivo && setRail(r))
      .catch(() => {
        if (!vivo) return;
        setRail(null);
        setError("No se pudo cargar el resumen.");
      })
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [companyId, intento]);
  return { rail, cargando, error, recargar: () => setIntento((n) => n + 1) };
}

const SIN_PEDIDOS: PedidoRail[] = [];

export function useNecesitoRail(companyId: string | null | undefined): PedidoRail[] {
  const { rail } = useRail(companyId);
  return rail?.necesito ?? SIN_PEDIDOS;
}

// ── Modo de la mascota (localStorage, compartido entre componentes) ─────────

export type ModoMascota = "pet" | "classic";
const LLAVE_MODO = "cos-pet-mode";
const EVENTO_MODO = "cos:pet-mode";

export function leerModoMascota(): ModoMascota {
  try {
    return localStorage.getItem(LLAVE_MODO) === "classic" ? "classic" : "pet";
  } catch {
    return "pet";
  }
}

export function fijarModoMascota(m: ModoMascota) {
  try {
    localStorage.setItem(LLAVE_MODO, m);
  } catch {
    /* modo privado: vale para esta pestaña */
  }
  window.dispatchEvent(new CustomEvent(EVENTO_MODO, { detail: m }));
}

export function useModoMascota(): [ModoMascota, (m: ModoMascota) => void] {
  const [modo, setModo] = useState<ModoMascota>("pet");
  useEffect(() => {
    setModo(leerModoMascota());
    const on = (e: Event) => setModo(((e as CustomEvent<ModoMascota>).detail as ModoMascota) ?? leerModoMascota());
    window.addEventListener(EVENTO_MODO, on);
    return () => window.removeEventListener(EVENTO_MODO, on);
  }, []);
  return [modo, fijarModoMascota];
}

// ── Personaje de la mascota (localStorage, compartido entre componentes) ────
// Preferencia del usuario en este navegador; luego vivirá en Configuración.

const LLAVE_PIEL = "cos-pet-skin";
const EVENTO_PIEL = "cos:pet-skin";

export function leerPiel(): Piel {
  try {
    return sanearPiel(JSON.parse(localStorage.getItem(LLAVE_PIEL) ?? "null"));
  } catch {
    return { ...PIEL_DEFAULT, colors: {} };
  }
}

export function fijarPiel(p: Piel) {
  try {
    localStorage.setItem(LLAVE_PIEL, JSON.stringify(p));
  } catch {
    /* modo privado: vale para esta pestaña */
  }
  window.dispatchEvent(new CustomEvent(EVENTO_PIEL, { detail: p }));
}

export function usePielMascota(): [Piel, (p: Piel) => void] {
  const [piel, setPiel] = useState<Piel>(PIEL_DEFAULT);
  useEffect(() => {
    setPiel(leerPiel());
    const on = (e: Event) => setPiel(sanearPiel((e as CustomEvent<Piel>).detail));
    window.addEventListener(EVENTO_PIEL, on);
    return () => window.removeEventListener(EVENTO_PIEL, on);
  }, []);
  return [piel, fijarPiel];
}
