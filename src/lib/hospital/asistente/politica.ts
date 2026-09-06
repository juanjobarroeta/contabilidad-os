// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — cuándo el hub se niega, decidido en puro (sin base):
//
//   · HospConfig.iaAsistencia = false apaga los cuatro endpoints (409).
//   · La transcripción en el servidor sólo existe con sttProveedor = "openai"
//     y OPENAI_API_KEY; si no, 409 y el satélite dicta con el reconocimiento
//     del navegador (Web Speech API) y manda el texto a estructurar.
//   · Un episodio cancelado no se asiste (409).
// ─────────────────────────────────────────────────────────────────────────────

import type { HospEpisodioEstado } from "@prisma/client";
import { HospitalError } from "../errores";

export const STT_PROVEEDORES = ["navegador", "openai"] as const;
export type SttProveedor = (typeof STT_PROVEEDORES)[number];

export const MENSAJE_IA_APAGADA = "La captura asistida está apagada para esta empresa: actívala en Configuración → Captura asistida (iaAsistencia)";
export const MENSAJE_STT_NAVEGADOR =
  "El reconocimiento de voz en el servidor no está activado: el satélite dicta con el reconocimiento del navegador (Web Speech API) y manda el texto a estructurar";
export const MENSAJE_STT_SIN_LLAVE =
  "El reconocimiento de voz en el servidor (OpenAI) está seleccionado pero este servidor no tiene OPENAI_API_KEY: el satélite dicta con el reconocimiento del navegador (Web Speech API) y manda el texto a estructurar";

export interface ConfigAsistente {
  iaAsistencia: boolean;
  sttProveedor: string | null;
}

/** Sin fila de HospConfig aplican los defaults del esquema. */
export const CONFIG_ASISTENTE_DEFAULT: ConfigAsistente = { iaAsistencia: true, sttProveedor: "navegador" };

/** El 409 que corresponde, o null si el asistente puede trabajar con este episodio. */
export function errorAsistente(config: ConfigAsistente | null | undefined, ep: { estado: HospEpisodioEstado; folio: string }): HospitalError | null {
  const c = config ?? CONFIG_ASISTENTE_DEFAULT;
  if (!c.iaAsistencia) return new HospitalError(409, MENSAJE_IA_APAGADA);
  if (ep.estado === "CANCELADO") return new HospitalError(409, `El episodio ${ep.folio} está cancelado`);
  return null;
}

/** El 409 de la transcripción en el servidor, o null si se puede transcribir aquí. */
export function errorStt(config: ConfigAsistente | null | undefined, hayLlaveOpenAi: boolean): HospitalError | null {
  const proveedor = (config?.sttProveedor ?? CONFIG_ASISTENTE_DEFAULT.sttProveedor ?? "navegador").trim().toLowerCase();
  if (proveedor !== "openai") return new HospitalError(409, MENSAJE_STT_NAVEGADOR);
  if (!hayLlaveOpenAi) return new HospitalError(409, MENSAJE_STT_SIN_LLAVE);
  return null;
}
