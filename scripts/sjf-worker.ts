/**
 * Worker de jurisprudencia de la SCJN (docs/MOTOR-JURIDICO.md F1). Corre
 * REMOTO en un servicio worker de Railway con Chromium (misma imagen que el
 * worker de CE, Dockerfile.ce-worker; start command `npm run sjf:worker`), o
 * local para probar la descarga sin base (SJF_SOLO_DESCARGA).
 *
 * Env: DATABASE_URL, OPENAI_API_KEY (embeddings). Opcionales:
 *   SJF_MODO=nuevas|completo   (default nuevas: se detiene en la primera página sin ids nuevos)
 *   SJF_EPOCAS=9a,10a,11a,12a  (default; vacío = todas)
 *   SJF_PAGINA_INICIO=0  SJF_MAX_PAGINAS=n  SJF_SIZE_PAGINA=1000  SJF_LOTE=50  SJF_CONCURRENCIA=6
 *   SJF_SOLO_DESCARGA=/ruta/salida.ndjson  (sin DB: escribe cada tesis como JSON por línea)
 */
import { appendFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { ClienteSjf } from "../src/lib/fiscal-kb/sjf/cliente";
import { sincronizarSjf } from "../src/lib/fiscal-kb/sjf/ingesta";

function num(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
}

async function main() {
  const soloDescarga = process.env.SJF_SOLO_DESCARGA;
  const modo = process.env.SJF_MODO === "completo" ? "completo" : "nuevas";
  const epocasRaw = process.env.SJF_EPOCAS ?? "9a,10a,11a,12a";
  const epocas = new Set(
    epocasRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.endsWith(".") ? s : `${s}.`))
  );
  const log = (m: string) => console.log(`[sjf ${new Date().toISOString().slice(11, 19)}] ${m}`);

  log(`modo=${modo} épocas=${[...epocas].join(",") || "todas"} página=${process.env.SJF_PAGINA_INICIO ?? 0}${soloDescarga ? ` sólo descarga → ${soloDescarga}` : ""}`);
  const cliente = await ClienteSjf.abrir({ log });
  try {
    const total = await cliente.count();
    log(`el API reporta ${total.toLocaleString("es-MX")} tesis`);
    const resumen = await sincronizarSjf({
      cliente,
      epocas,
      modo,
      paginaInicio: num(process.env.SJF_PAGINA_INICIO),
      maxPaginas: num(process.env.SJF_MAX_PAGINAS),
      sizePagina: num(process.env.SJF_SIZE_PAGINA),
      lote: num(process.env.SJF_LOTE),
      concurrencia: num(process.env.SJF_CONCURRENCIA),
      log,
      soloDescarga: soloDescarga ? (t) => appendFileSync(soloDescarga, JSON.stringify(t) + "\n") : undefined,
    });
    log(
      `RESUMEN · páginas=${resumen.paginas} ids=${resumen.idsVistos} descargadas=${resumen.descargadas} nuevas=${resumen.ingeridas} ` +
        `actualizadas=${resumen.actualizadas} sinCambios=${resumen.sinCambios} fueraDeÉpoca=${resumen.saltadasEpoca} fallidas=${resumen.fallidas} ` +
        `· ${(resumen.ms / 60000).toFixed(1)} min · por Época: ${JSON.stringify(resumen.porEpoca)}`
    );
    if (resumen.fallidas > 0 && resumen.descargadas === 0) process.exitCode = 1;
  } finally {
    await cliente.cerrar();
  }
}

const prisma = new PrismaClient();
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
