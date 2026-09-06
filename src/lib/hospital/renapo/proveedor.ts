// ─────────────────────────────────────────────────────────────────────────────
// El proveedor de consultas a RENAPO se elige por variables de entorno del
// hub: RENAPO_PROVEEDOR=tlaloc (TLALOC_API_KEY) | nubarium (NUBARIUM_USUARIO,
// NUBARIUM_PASSWORD). Sin proveedor configurado, `obtenerProveedor` devuelve
// null y las rutas contestan `disponible: false` (la CURP sigue validándose
// localmente y se calcula la probable). Las credenciales nunca se loguean.
// ─────────────────────────────────────────────────────────────────────────────

import { proveedorNubarium } from "./nubarium";
import { proveedorTlaloc } from "./tlaloc";
import type { FetchLike, ProveedorRenapo } from "./base";
import type { ProveedorRenapoNombre } from "./tipos";

export { fetchConTimeout, TIMEOUT_RENAPO_MS } from "./base";
export type { FetchLike, ProveedorRenapo } from "./base";

export interface EstadoProveedor {
  proveedor: ProveedorRenapoNombre | null;
  configurado: boolean;
  /** Por qué no está disponible, para la respuesta al satélite. */
  motivo: string | null;
}

/** Variables de entorno relevantes (inyectables en pruebas). */
export type EntornoRenapo = Record<string, string | undefined>;

export function estadoProveedor(env: EntornoRenapo = process.env): EstadoProveedor {
  const nombre = (env.RENAPO_PROVEEDOR ?? "").trim().toLowerCase();
  if (!nombre) return { proveedor: null, configurado: false, motivo: "Consulta a RENAPO no configurada (RENAPO_PROVEEDOR)" };
  if (nombre === "tlaloc") {
    if (!env.TLALOC_API_KEY?.trim()) return { proveedor: "tlaloc", configurado: false, motivo: "Falta TLALOC_API_KEY para consultar RENAPO" };
    return { proveedor: "tlaloc", configurado: true, motivo: null };
  }
  if (nombre === "nubarium") {
    if (!env.NUBARIUM_USUARIO?.trim() || !env.NUBARIUM_PASSWORD?.trim()) {
      return { proveedor: "nubarium", configurado: false, motivo: "Faltan NUBARIUM_USUARIO / NUBARIUM_PASSWORD para consultar RENAPO" };
    }
    return { proveedor: "nubarium", configurado: true, motivo: null };
  }
  return { proveedor: null, configurado: false, motivo: `RENAPO_PROVEEDOR desconocido: «${nombre}» (tlaloc | nubarium)` };
}

/** El proveedor configurado, o null cuando el hub no tiene credenciales. */
export function obtenerProveedor(env: EntornoRenapo = process.env, fetchImpl: FetchLike = fetch): ProveedorRenapo | null {
  const estado = estadoProveedor(env);
  if (!estado.configurado) return null;
  if (estado.proveedor === "tlaloc") return proveedorTlaloc(env.TLALOC_API_KEY!.trim(), { fetchImpl });
  if (estado.proveedor === "nubarium") return proveedorNubarium(env.NUBARIUM_USUARIO!.trim(), env.NUBARIUM_PASSWORD!.trim(), { fetchImpl });
  return null;
}
