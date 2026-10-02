// ─────────────────────────────────────────────────────────────────────────────
// ¿Se le vuelve a pedir al SAT EXACTAMENTE la misma solicitud?
//
// La cuota 5002 es vitalicia por (RFC + rango + tipo) y la consume cada
// solicitud que el SAT ACEPTA, aunque luego la verificación diga «Error no
// controlado». Medido el 2026-10-02 (CENTRO, emitidos 2026-10-01→01): aceptada
// y fallida a las 00:02, otra vez a las 00:55, y a las 17:01 ya «agotadas de
// por vida». Lo que las encadenaba: una fila FAILED no se reutiliza, así que
// sat-backfill (cada 10 min) y sat-sync (cada 4 h) pedían el mismo rango otra
// vez en cuanto fallaba. Dos intentos por rango es el tope real del SAT.
//
// Decisión PURA por rango exacto, sobre las solicitudes previas de ese rango:
//   · hubo 5002           → nunca más (ni con force): sólo repite el rechazo.
//   · ≥ MAX_FALLOS fallos → tampoco: el siguiente intento es el que devuelve
//                           5002, y de paso deja el rango marcado.
//   · fallo reciente      → esperar REINTENTO_TRAS_FALLO_HORAS (force lo salta):
//                           los «Error no controlado» del SAT suelen ser caídas
//                           de horas, y el mes en curso cambia de rango cada
//                           día, así que esperar no pierde nada.
// Las solicitudes en vuelo o terminadas no se miran aquí: ésas se REUTILIZAN
// (ver REUSE en sat-sync), que es la otra mitad de no gastar cuota.
// ─────────────────────────────────────────────────────────────────────────────

/** Horas de espera tras un fallo antes de volver a pedir el mismo rango. */
export const REINTENTO_TRAS_FALLO_HORAS = 12;
/** Fallos (no 5002) tolerados por rango exacto antes de darlo por quemado. */
export const MAX_FALLOS_POR_RANGO = 2;
/** El SAT conserva una solicitud ~72 h; después ya no se puede verificar. */
export const VIDA_SOLICITUD_SAT_HORAS = 72;

export interface SolicitudPrevia {
  status: string;
  errorMessage?: string | null;
  createdAt: Date | string;
}

export type DecisionSolicitud =
  | { pedir: true }
  | { pedir: false; motivo: "cuota_agotada" | "intentos_agotados" | "en_espera"; detalle: string };

const esCuota = (s: SolicitudPrevia) => s.status === "FAILED" && (s.errorMessage ?? "").includes("5002");

export function decidirNuevaSolicitud(
  previas: SolicitudPrevia[],
  ahora: Date,
  opts: { force?: boolean } = {},
): DecisionSolicitud {
  if (previas.some(esCuota)) {
    return { pedir: false, motivo: "cuota_agotada", detalle: "el SAT agotó las solicitudes de por vida para este rango (5002)" };
  }
  const fallos = previas.filter((s) => s.status === "FAILED" && !esCuota(s));
  if (fallos.length >= MAX_FALLOS_POR_RANGO) {
    return {
      pedir: false,
      motivo: "intentos_agotados",
      detalle: `${fallos.length} solicitudes de este rango ya fallaron en el SAT; una más sólo lo quema de por vida. Pide otro rango (tramos).`,
    };
  }
  const ultimo = fallos.map((s) => new Date(s.createdAt).getTime()).sort((a, b) => b - a)[0];
  if (ultimo != null && !opts.force) {
    const horas = (ahora.getTime() - ultimo) / 3_600_000;
    if (horas < REINTENTO_TRAS_FALLO_HORAS) {
      const faltan = Math.ceil(REINTENTO_TRAS_FALLO_HORAS - horas);
      return { pedir: false, motivo: "en_espera", detalle: `falló hace ${Math.floor(horas)} h; se reintenta en ${faltan} h` };
    }
  }
  return { pedir: true };
}

/** ¿La solicitud sigue viva en el SAT? (menos de 72 h desde que se creó) */
export function solicitudViva(createdAt: Date | string, ahora: Date): boolean {
  return ahora.getTime() - new Date(createdAt).getTime() < VIDA_SOLICITUD_SAT_HORAS * 3_600_000;
}
