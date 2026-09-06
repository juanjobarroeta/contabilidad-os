// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — lo que repiten las cuatro rutas /episodios/[id]/asistente/*
// además de requireWriter + requireModule (que cada ruta llama a la vista, como
// exige la guardia estática de src/lib/api-guardias.test.ts): el episodio (404)
// y la política de la empresa (iaAsistencia / sttProveedor → 409, episodio
// cancelado → 409). Vive aquí porque Next no admite exports ajenos a los
// handlers en un route.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospEpisodioEstado, HospEpisodioTipo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { HospitalError } from "../errores";
import { CONFIG_ASISTENTE_DEFAULT, errorAsistente, errorStt, type ConfigAsistente } from "./politica";
import { sttConfigurado } from "./stt";

export interface EpisodioAutorizable {
  id: string;
  companyId: string;
  folio: string;
  estado: HospEpisodioEstado;
  tipo: HospEpisodioTipo;
  pacienteId: string;
}

/** El episodio con lo que las rutas necesitan para autorizar; 404 si no existe. */
export async function episodioAsistente(episodioId: string): Promise<EpisodioAutorizable> {
  const ep = await prisma.hospEpisodio.findUnique({
    where: { id: episodioId },
    select: { id: true, companyId: true, folio: true, estado: true, tipo: true, pacienteId: true },
  });
  if (!ep) throw new HospitalError(404, "Episodio no encontrado");
  return ep;
}

/**
 * Se llama DESPUÉS de requireWriter/requireModule: lee HospConfig y lanza el
 * 409 de la política (IA apagada, STT sin proveedor/llave, cancelado).
 */
export async function exigirPoliticaAsistente(ep: EpisodioAutorizable, opciones: { stt?: boolean } = {}): Promise<ConfigAsistente> {
  const fila = await prisma.hospConfig.findUnique({ where: { companyId: ep.companyId }, select: { iaAsistencia: true, sttProveedor: true } });
  const config: ConfigAsistente = fila ? { iaAsistencia: fila.iaAsistencia, sttProveedor: fila.sttProveedor } : CONFIG_ASISTENTE_DEFAULT;
  const e = errorAsistente(config, ep) ?? (opciones.stt ? errorStt(config, sttConfigurado()) : null);
  if (e) throw e;
  return config;
}
