// ─────────────────────────────────────────────────────────────────────────────
// Verificación de VIGENCIA de un CFDI por UUID contra el servicio público del
// SAT (ConsultaCFDIService — el mismo que respalda verificacfdi.facturaelectronica
// .sat.gob.mx). Complementa al cancel-sync de descarga masiva, que sólo cubre
// una ventana de meses y consume cuota vitalicia (código 5002): una cancelación
// vieja fuera de ventana (caso real: factura de enero cancelada en marzo al
// re-emitirse) sólo se detecta por esta vía. No requiere FIEL ni consume cuota
// de descarga masiva.
//
// La consulta necesita la "expresión impresa" del CFDI: RFC emisor (re), RFC
// receptor (rr), total (tt) y UUID (id). Los tres primeros se extraen del
// rawXml guardado — usar el atributo Total VERBATIM del XML evita desajustes
// de formato (el SAT compara contra lo timbrado).
//
// Helpers puros (extracción/parseo) separados del fetch, convención del repo.
// ─────────────────────────────────────────────────────────────────────────────

const CONSULTA_URL = "https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc";
const SOAP_ACTION = "http://tempuri.org/IConsultaCFDIService/Consulta";

export interface DatosConsultaCfdi {
  re: string; // RFC emisor
  rr: string; // RFC receptor
  tt: string; // total, verbatim del XML
  id: string; // UUID
}

/**
 * Extrae emisor/receptor/total del CFDI XML (atributos de cfdi:Emisor,
 * cfdi:Receptor y Total del comprobante). Regex y no un parser XML completo:
 * los atributos son planos y el rawXml viene del SAT (bien formado). Null si
 * falta cualquiera — el llamador decide su fallback.
 */
export function datosConsultaDesdeXml(rawXml: string, uuid: string): DatosConsultaCfdi | null {
  const attr = (tag: string, name: string): string | null => {
    const m = rawXml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
    return m ? m[1] : null;
  };
  const re = attr("Emisor", "Rfc");
  const rr = attr("Receptor", "Rfc");
  const tt = attr("Comprobante", "Total");
  if (!re || !rr || !tt) return null;
  return { re, rr, tt, id: uuid };
}

/** Expresión impresa `?re=...&rr=...&tt=...&id=...` que espera el servicio. */
export function construirExpresion(d: DatosConsultaCfdi): string {
  return `?re=${d.re}&rr=${d.rr}&tt=${d.tt}&id=${d.id}`;
}

export interface EstadoCfdi {
  /** "Vigente" | "Cancelado" | "No Encontrado" (textual del SAT). */
  estado: string;
  esCancelable: string | null;
  estatusCancelacion: string | null;
}

/**
 * Parsea la respuesta SOAP de Consulta. Los elementos vienen con prefijo de
 * namespace variable (a:Estado / b:Estado), por eso el regex ignora el prefijo.
 * Null si la respuesta no trae Estado (error del servicio).
 */
export function parseEstadoConsulta(soapXml: string): EstadoCfdi | null {
  const texto = (tag: string): string | null => {
    const m = soapXml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`, "i"));
    return m ? m[1].trim() : null;
  };
  const estado = texto("Estado");
  if (!estado) return null;
  return {
    estado,
    esCancelable: texto("EsCancelable"),
    estatusCancelacion: texto("EstatusCancelacion"),
  };
}

/** ¿El SAT reporta el CFDI como cancelado? (comparación laxa por si cambia el casing). */
export function esCancelado(e: EstadoCfdi): boolean {
  return e.estado.trim().toLowerCase() === "cancelado";
}

/**
 * Llama al servicio de consulta del SAT para una expresión. Lanza en errores de
 * red/HTTP; devuelve null si la respuesta no es parseable — el llamador decide
 * (en el cron: se cuenta como error y se sigue con la siguiente factura).
 */
export async function consultarEstadoCfdi(
  expresion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EstadoCfdi | null> {
  const body = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Consulta>
      <tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa>
    </tem:Consulta>
  </soapenv:Body>
</soapenv:Envelope>`;
  const res = await fetchImpl(CONSULTA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: SOAP_ACTION,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ConsultaCFDI HTTP ${res.status}`);
  return parseEstadoConsulta(await res.text());
}
