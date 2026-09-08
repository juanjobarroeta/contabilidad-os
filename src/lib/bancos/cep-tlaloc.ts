// ─────────────────────────────────────────────────────────────────────────────
// CEP de Banxico (vía Tláloc) — el RFC que el estado de cuenta no trae.
//
// POR QUÉ. La conciliación automática identifica por RFC: vale 120 puntos, más
// que el importe exacto, porque un RFC que empata ES la misma persona y el
// monto sólo confirma. Pero medido sobre un hospital real: de 172 movimientos
// del mes, CERO traían RFC. El banco imprime el nombre, la CLABE y la clave de
// rastreo — nunca el RFC.
//
// El CEP (Comprobante Electrónico de Pago) sí lo trae. Es el comprobante que
// Banxico publica de cada SPEI, con ordenante y beneficiario COMPLETOS: nombre,
// banco, cuenta y RFC. Se consulta con la clave de rastreo, y una consulta por
// contraparte alcanza para siempre: el par CLABE→RFC queda aprendido.
//
//   GET https://api.tlaloc.sh/mx/v1/cep
//       ?fecha=YYYY-MM-DD&tipo_criterio=T&criterio=<clave de rastreo>
//       &emisor=<5 díg>&receptor=<5 díg>&cuenta=<CLABE beneficiaria>&monto=…
//       Authorization: Bearer ${TLALOC_API_KEY}
//
// La respuesta trae campos ya desglosados (nombres, estado, instituciones) pero
// el RFC SÓLO viene dentro del XML firmado, así que de ahí se lee.
// ─────────────────────────────────────────────────────────────────────────────

export const CEP_URL = "https://api.tlaloc.sh/mx/v1/cep";
const TIMEOUT_MS = 12_000;

export type FetchLike = typeof fetch;

/** Una de las dos partes del SPEI, tal como las firma Banxico. */
export interface ParteCep {
  nombre: string | null;
  rfc: string | null;
  cuenta: string | null;
  banco: string | null;
}

export interface Cep {
  ordenante: ParteCep;
  beneficiario: ParteCep;
  concepto: string | null;
  monto: number | null;
  fechaOperacion: string | null;
  estado: string | null;
}

export interface ParamsCep {
  /** Fecha de la operación SEGÚN EL ESTADO DE CUENTA (no la del XML: Banxico
   *  responde 404 si se le manda la fecha que él mismo devuelve). */
  fecha: string;
  claveRastreo: string;
  /** Institución SPEI de 5 dígitos («40» + los 3 de la CLABE). */
  emisor: string;
  receptor: string;
  /** CLABE de la cuenta BENEFICIARIA. */
  cuenta: string;
  monto: number;
}

const attr = (xml: string, tag: string, nombre: string): string | null => {
  const bloque = new RegExp(`<${tag}\\b[^>]*>`).exec(xml)?.[0];
  if (!bloque) return null;
  const v = new RegExp(`${nombre}="([^"]*)"`).exec(bloque)?.[1]?.trim();
  return v ? v : null;
};

/**
 * Lee el XML firmado del CEP. PURA.
 *
 * OJO con los nombres: Banxico los parte en bloques de ancho fijo y a veces
 * corta a media palabra («CENTRO DE PROCEDIMIE NTOS MINIMAMENTE IN»). Se
 * colapsan los espacios pero NO se intenta recomponer: el dato bueno de esta
 * consulta es el RFC, y el nombre se guarda sólo si no había otro.
 */
export function parseCepXml(xml: string): Cep | null {
  if (!xml || !/<(SPEI_Tercero|Beneficiario)\b/.test(xml)) return null;
  const limpio = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() : null);
  const monto = attr(xml, "Beneficiario", "MontoPago");
  return {
    ordenante: {
      nombre: limpio(attr(xml, "Ordenante", "Nombre")),
      rfc: attr(xml, "Ordenante", "RFC")?.toUpperCase() ?? null,
      cuenta: attr(xml, "Ordenante", "Cuenta"),
      banco: limpio(attr(xml, "Ordenante", "BancoEmisor")),
    },
    beneficiario: {
      nombre: limpio(attr(xml, "Beneficiario", "Nombre")),
      rfc: attr(xml, "Beneficiario", "RFC")?.toUpperCase() ?? null,
      cuenta: attr(xml, "Beneficiario", "Cuenta"),
      banco: limpio(attr(xml, "Beneficiario", "BancoReceptor")),
    },
    concepto: limpio(attr(xml, "Beneficiario", "Concepto")),
    monto: monto ? Number(monto) : null,
    fechaOperacion: attr(xml, "SPEI_Tercero", "FechaOperacion"),
    estado: null,
  };
}

/** Institución SPEI (5 dígitos) desde una CLABE: «40» + los 3 del banco. */
export function institucionSpei(clabe: string | null | undefined): string | null {
  const c = (clabe ?? "").replace(/\D/g, "");
  return c.length >= 3 ? `40${c.slice(0, 3)}` : null;
}

/**
 * Arma los parámetros del CEP para un movimiento bancario.
 *
 * La CUENTA que pide Banxico es la del BENEFICIARIO, así que depende del
 * sentido: en un cargo (SPEI enviado) el beneficiario es la contraparte; en un
 * depósito (SPEI recibido) el beneficiario somos nosotros. Mandarlo al revés
 * devuelve 404 y parecería que la operación no existe.
 */
export function paramsDesdeMovimiento(
  tx: { fecha: Date; monto: number; claveRastreo: string | null; contraparteClabe: string | null },
  clabePropia: string | null,
): ParamsCep | null {
  if (!tx.claveRastreo || !tx.contraparteClabe || !clabePropia) return null;
  const instPropia = institucionSpei(clabePropia);
  const instOtro = institucionSpei(tx.contraparteClabe);
  if (!instPropia || !instOtro) return null;
  const enviado = tx.monto < 0;
  return {
    fecha: tx.fecha.toISOString().slice(0, 10),
    claveRastreo: tx.claveRastreo,
    emisor: enviado ? instPropia : instOtro,
    receptor: enviado ? instOtro : instPropia,
    cuenta: enviado ? tx.contraparteClabe.replace(/\D/g, "") : clabePropia.replace(/\D/g, ""),
    monto: Math.abs(tx.monto),
  };
}

/** ¿Cuál de las dos partes del CEP es la CONTRAPARTE de este movimiento? */
export function contraparteDeCep(cep: Cep, monto: number): ParteCep {
  return monto < 0 ? cep.beneficiario : cep.ordenante;
}

export class CepError extends Error {}

/**
 * Consulta el CEP. Devuelve null cuando Banxico no encuentra la operación
 * (404: pasa con traspasos entre cuentas propias y con claves mal leídas) —
 * eso NO es un error, es una respuesta. Lanza sólo cuando falla la llamada.
 */
export async function consultarCep(
  p: ParamsCep,
  opts: { apiKey?: string; fetchImpl?: FetchLike } = {},
): Promise<Cep | null> {
  const apiKey = (opts.apiKey ?? process.env.TLALOC_API_KEY ?? "").trim();
  if (!apiKey) throw new CepError("Falta TLALOC_API_KEY");
  const f = opts.fetchImpl ?? fetch;
  const url = new URL(CEP_URL);
  url.searchParams.set("fecha", p.fecha);
  url.searchParams.set("tipo_criterio", "T");
  url.searchParams.set("criterio", p.claveRastreo);
  url.searchParams.set("emisor", p.emisor);
  url.searchParams.set("receptor", p.receptor);
  url.searchParams.set("cuenta", p.cuenta);
  url.searchParams.set("monto", p.monto.toFixed(2));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
  } catch (e) {
    throw new CepError(e instanceof Error ? e.message : "no se pudo consultar el CEP");
  } finally {
    clearTimeout(t);
  }
  if (res.status === 404) return null;
  const cuerpo = (await res.json().catch(() => null)) as
    | { found?: boolean; xml_content?: string; estado?: string; error?: string; details?: string }
    | null;
  // Banxico contesta 200 con un error envuelto cuando no halla la operación.
  if (!res.ok || !cuerpo || cuerpo.error) {
    if (String(cuerpo?.details ?? "").includes("404")) return null;
    throw new CepError(`CEP HTTP ${res.status}: ${cuerpo?.error ?? "respuesta ilegible"}`);
  }
  if (cuerpo.found === false || !cuerpo.xml_content) return null;
  const cep = parseCepXml(cuerpo.xml_content);
  return cep ? { ...cep, estado: cuerpo.estado ?? null } : null;
}
