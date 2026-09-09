// ─────────────────────────────────────────────────────────────────────────────
// Descarga de los XML de Contabilidad Electrónica desde el SAT, dentro de una
// sesión del buzón ya abierta (buzon-playwright.ts). Reemplaza la fuente Syntage.
//
// La consulta de acuses (operacion/16203) corre la app real en un iframe
// (ceportalconsultaextprod.clouda.sat.gob.mx). Se llena el form, se Busca, y por
// cada folio se dispara `VerXML('<folio>')`, que baja un ZIP con el XML. Se
// descomprime con jszip. El año/mes/tipo salen del nombre del archivo del SAT:
//   RFC + YYYY + MM + {BN|BC|CT|PL|XF|XC}.xml  (BN/BC = balanza, CT = catálogo).
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import type { Page } from "playwright";
import JSZip from "jszip";

export interface CeXml {
  anio: number;
  mes: number;
  /** "B" = balanza (BN/BC), "CT" = catálogo, u otro (PL/XF/XC). */
  tipo: "B" | "CT" | string;
  nombre: string;
  xml: string;
}

const CONSULTA =
  "https://wwwmat.sat.gob.mx/consultas/login/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica";

/**
 * Baja los XML de CE de UN AÑO en la sesión del buzón ya abierta. `page` debe
 * estar autenticada (abrirBuzonSat). tipoArchivo: "0"=Todos, "1"=CT, "2"=B.
 * Motivo es REQUERIDO por el form ("0"=Todos). Devuelve los XML descomprimidos.
 */
export async function descargarCeAnioSat(
  page: Page,
  opts: { anio: number | string; tipoArchivo?: string; motivo?: string },
): Promise<CeXml[]> {
  await page.goto(CONSULTA, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const app = page.frames().find((f) => /ceportalconsulta/.test(f.url()));
  if (!app) throw new Error("no cargó el iframe de la app de CE (¿sesión sin buzón?)");

  const pendientes: Promise<{ nombre: string; buf: Buffer }>[] = [];
  const onDownload = (d: import("playwright").Download) => {
    pendientes.push(
      (async () => {
        const p = await d.path();
        return { nombre: d.suggestedFilename(), buf: p ? fs.readFileSync(p) : Buffer.alloc(0) };
      })(),
    );
  };
  page.on("download", onDownload);
  try {
    await app.check("#rdoCriterios").catch(() => {});
    await app.selectOption("#ddlAnio", String(opts.anio));
    await app.selectOption("#ddlMesInicio", "1");
    await app.selectOption("#ddlMesFin", "13");
    await app.selectOption("#ddlMotivo", opts.motivo ?? "0"); // REQUERIDO
    await app.selectOption("#ddlTipoArchivo", opts.tipoArchivo ?? "0");
    await app.selectOption("#ddlEstatus", "0");
    await app.selectOption("#ddlTipoEnvio", "0");
    await app.click("#btnBuscar").catch(() => {});
    await page.waitForTimeout(4000);

    const folios: string[] = await app.evaluate(() => {
      const s = new Set<string>();
      document.querySelectorAll("[onclick]").forEach((e) => {
        const m = /VerXML\('([^']+)'\)/.exec(e.getAttribute("onclick") || "");
        if (m) s.add(m[1]);
      });
      return Array.from(s);
    });

    for (const folio of folios) {
      await app
        .evaluate((f) => (window as unknown as { VerXML: (x: string) => void }).VerXML(f), folio)
        .catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(2500);
  } finally {
    page.off("download", onDownload);
  }

  const zips = await Promise.all(pendientes);
  const out: CeXml[] = [];
  for (const z of zips) {
    if (!z.buf.length) continue;
    try {
      const zip = await JSZip.loadAsync(z.buf);
      for (const nombre of Object.keys(zip.files)) {
        if (zip.files[nombre].dir) continue;
        const xml = await zip.files[nombre].async("string");
        const m = /(\d{4})(\d{2})(BN|BC|CT|PL|XF|XC)\.xml$/i.exec(nombre);
        const tipoRaw = (m?.[3] ?? "").toUpperCase();
        out.push({
          anio: m ? Number(m[1]) : 0,
          mes: m ? Number(m[2]) : 0,
          tipo: tipoRaw.startsWith("B") ? "B" : tipoRaw || "?",
          nombre,
          xml,
        });
      }
    } catch {
      // un ZIP corrupto no tumba el resto
    }
  }
  return out;
}
