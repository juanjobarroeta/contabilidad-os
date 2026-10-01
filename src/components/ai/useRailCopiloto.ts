"use client";

import { useEffect, useState } from "react";
import type { PedidoRail } from "@/lib/rail/armar";

// El `necesito[]` del rail, compartido por la mascota (pistas al cambiar de
// pantalla) y el chat (píldoras de sugerencia). Caché de módulo de un minuto
// y una sola petición en vuelo por empresa: los dos lo piden al montar.

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; necesito: PedidoRail[] }>();
const enVuelo = new Map<string, Promise<PedidoRail[]>>();

function pedir(companyId: string): Promise<PedidoRail[]> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.necesito);
  const ya = enVuelo.get(companyId);
  if (ya) return ya;
  const p = fetch(`/api/rail?companyId=${companyId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { necesito?: PedidoRail[] } | null) => {
      const necesito = Array.isArray(j?.necesito) ? j!.necesito : [];
      cache.set(companyId, { at: Date.now(), necesito });
      return necesito;
    })
    .catch(() => [] as PedidoRail[])
    .finally(() => enVuelo.delete(companyId));
  enVuelo.set(companyId, p);
  return p;
}

export function useNecesitoRail(companyId: string | null | undefined): PedidoRail[] {
  const [necesito, setNecesito] = useState<PedidoRail[]>([]);
  useEffect(() => {
    if (!companyId) {
      setNecesito([]);
      return;
    }
    let vivo = true;
    void pedir(companyId).then((n) => vivo && setNecesito(n));
    return () => {
      vivo = false;
    };
  }, [companyId]);
  return necesito;
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
