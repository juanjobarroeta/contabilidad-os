// ─────────────────────────────────────────────────────────────────────────────
// Descarga de un ordenamiento con tolerancia a certificados mal instalados.
//
// Varios congresos estatales (Hidalgo, Estado de México, Veracruz, la
// Consejería de la CDMX, Irapuato) sirven sus PDF con la cadena TLS incompleta
// —no mandan la CA intermedia— y `fetch` falla con
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. El navegador lo tolera porque trae la
// intermedia cacheada; Node no. Como lo que se baja son textos públicos de
// sitios .gob.mx, se reintenta SIN verificar la cadena, pero sólo para esos
// hosts y sólo tras ese tipo de error: nunca se apaga TLS globalmente.
// ─────────────────────────────────────────────────────────────────────────────

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const ERRORES_DE_CADENA = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"]);

export function esErrorDeCadena(e: unknown): boolean {
  const causa = (e as { cause?: { code?: string; message?: string } })?.cause;
  return !!causa && (ERRORES_DE_CADENA.has(causa.code ?? "") || /certificate|self.signed|CERT_/i.test(causa.message ?? ""));
}

/** Sólo sitios de gobierno mexicano: ahí una cadena rota es descuido del webmaster, no un ataque que valga la pena. */
export function permiteCadenaRota(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "gob.mx" || host.endsWith(".gob.mx");
  } catch {
    return false;
  }
}

export interface Descarga {
  status: number;
  contentType: string | null;
  buffer: Uint8Array;
  cadenaRota: boolean;
}

function bajarSinVerificar(url: string, headers: Record<string, string>, saltos = 0): Promise<Descarga> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method: "GET", headers, rejectUnauthorized: false }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && saltos < 5) {
        res.resume();
        resolve(bajarSinVerificar(new URL(res.headers.location, url).toString(), headers, saltos + 1));
        return;
      }
      const partes: Buffer[] = [];
      res.on("data", (c: Buffer) => partes.push(c));
      res.on("end", () => resolve({ status, contentType: res.headers["content-type"] ?? null, buffer: new Uint8Array(Buffer.concat(partes)), cadenaRota: true }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/** fetch normal; si falla por la cadena TLS y el host es .gob.mx, reintenta sin verificarla. */
export async function descargar(url: string, headers: Record<string, string>): Promise<Descarga> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    return { status: res.status, contentType: res.headers.get("content-type"), buffer: new Uint8Array(await res.arrayBuffer()), cadenaRota: false };
  } catch (e) {
    if (esErrorDeCadena(e) && permiteCadenaRota(url)) {
      console.warn(`[fiscal-kb] ${new URL(url).hostname}: cadena TLS incompleta; se baja sin verificar (sitio .gob.mx).`);
      return bajarSinVerificar(url, headers);
    }
    throw e;
  }
}
