// ─────────────────────────────────────────────────────────────────────────────
// Cliente del API de datos abiertos de la SCJN a través de un navegador.
//
// El API (bicentenario.scjn.gob.mx/repositorio-scjn/api/v1) es público, pero el
// sitio está detrás de Incapsula: un `fetch` de Node recibe la página «Loading»
// del reto JavaScript. Un Chromium real resuelve el reto al abrir la página y
// desde ahí las peticiones al mismo origen pasan. Así que: se abre la página
// una vez y todas las llamadas se hacen con `fetch` DENTRO de la página
// (page.evaluate), con las cookies del reto. Si el reto vuelve (la sesión de
// Incapsula caduca), la respuesta es HTML en vez de JSON: se recarga la página y
// se reintenta.
//
// Mismo Chromium que el worker de CE del SAT (Dockerfile.ce-worker).
// ─────────────────────────────────────────────────────────────────────────────

import type { Browser, Page } from "playwright";
import { SJF_API, SJF_BASE, type TesisSjf } from "./normalizar";

export interface RespuestaSjf {
  id: string;
  status: number;
  cuerpo: string;
}

export interface OpcionesCliente {
  /** Milisegundos de espera tras abrir la página (el reto de Incapsula corre ahí). */
  esperaInicialMs?: number;
  log?: (msg: string) => void;
}

function esReto(cuerpo: string): boolean {
  const s = cuerpo.trimStart().slice(0, 200).toLowerCase();
  return s.startsWith("<") || s.includes("incapsula") || s.includes("<html");
}

export class ClienteSjf {
  private constructor(
    private browser: Browser,
    private page: Page,
    private opts: OpcionesCliente
  ) {}

  static async abrir(opts: OpcionesCliente = {}): Promise<ClienteSjf> {
    // Import perezoso: playwright sólo existe en el worker (devDependency), y
    // este módulo lo importan también las pruebas puras del normalizador.
    const { chromium } = await import("playwright");
    // Medido el 2026-09-11 contra el reto de Incapsula: el headless clásico
    // (headless_shell) recibe 403 para siempre; el headless NUEVO (channel
    // "chromium", el navegador completo) con la bandera de automatización
    // apagada y `navigator.webdriver` oculto pasa el reto en la primera carga
    // (igual que un navegador con ventana). `playwright install chromium` trae
    // los dos binarios, también en la imagen del worker.
    const browser = await chromium.launch({
      headless: true,
      channel: "chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      locale: "es-MX",
      viewport: { width: 1366, height: 800 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    const c = new ClienteSjf(browser, page, opts);
    await c.abrirPagina();
    return c;
  }

  /**
   * Abre la página del repositorio (el reto de Incapsula corre ahí y deja sus
   * cookies) y comprueba con `count` que el API ya responde JSON; si no, espera
   * y recarga, hasta 4 veces.
   */
  private async abrirPagina(): Promise<void> {
    for (let intento = 1; intento <= 4; intento++) {
      if (intento === 1) await this.page.goto(`${SJF_BASE}/sjf`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      else await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.page.waitForTimeout(this.opts.esperaInicialMs ?? 5_000);
      const sonda = await this.page.evaluate(async (u: string) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return { status: r.status, cuerpo: (await r.text()).slice(0, 40) };
        } catch (e) {
          return { status: 0, cuerpo: String(e) };
        }
      }, `${SJF_API}/tesis/count`);
      if (sonda.status === 200 && /^\d+$/.test(sonda.cuerpo.trim())) return;
      this.opts.log?.(`reto de Incapsula aún activo (HTTP ${sonda.status}); reintento ${intento}/4`);
    }
    throw new Error("No se pudo pasar el reto de Incapsula del sitio de la SCJN tras 4 intentos.");
  }

  /** GET relativo al API, con hasta 3 recargas de página si vuelve el reto. */
  async get(ruta: string): Promise<RespuestaSjf> {
    const [r] = await this.getLote([ruta], 1);
    return r;
  }

  /**
   * Varias rutas en paralelo dentro de la página (un solo evaluate; `n`
   * peticiones a la vez). Devuelve status + cuerpo crudo por ruta, en orden.
   */
  async getLote(rutas: string[], concurrencia = 6): Promise<RespuestaSjf[]> {
    for (let intento = 1; ; intento++) {
      const res = await this.page.evaluate(
        async ({ base, rutas, n }: { base: string; rutas: string[]; n: number }) => {
          const out: { id: string; status: number; cuerpo: string }[] = new Array(rutas.length);
          let i = 0;
          await Promise.all(
            Array.from({ length: Math.min(n, rutas.length) }, async () => {
              for (;;) {
                const k = i++;
                if (k >= rutas.length) return;
                try {
                  const r = await fetch(`${base}${rutas[k]}`, { credentials: "include", headers: { Accept: "application/json" } });
                  out[k] = { id: rutas[k], status: r.status, cuerpo: await r.text() };
                } catch (e) {
                  out[k] = { id: rutas[k], status: 0, cuerpo: String(e) };
                }
              }
            })
          );
          return out;
        },
        { base: SJF_API, rutas, n: concurrencia }
      );
      const conReto = res.filter((r) => r.status === 200 && esReto(r.cuerpo)).length;
      if (conReto === 0 || intento >= 3) return res;
      this.opts.log?.(`reto de Incapsula en ${conReto}/${res.length} respuestas; recargo la página (intento ${intento})`);
      await this.abrirPagina();
    }
  }

  async count(): Promise<number> {
    const r = await this.get("/tesis/count");
    const n = Number(r.cuerpo.trim());
    if (r.status !== 200 || !Number.isFinite(n)) throw new Error(`count: HTTP ${r.status} — ${r.cuerpo.slice(0, 120)}`);
    return n;
  }

  /** Página de ids (base 0, hasta 1 000). Vacía cuando se acabaron. */
  async ids(pagina: number, size = 1000): Promise<string[]> {
    const r = await this.get(`/tesis/ids?page=${pagina}&size=${size}`);
    if (r.status !== 200) throw new Error(`ids página ${pagina}: HTTP ${r.status} — ${r.cuerpo.slice(0, 120)}`);
    const arr = JSON.parse(r.cuerpo) as unknown;
    if (!Array.isArray(arr)) throw new Error(`ids página ${pagina}: respuesta no es lista`);
    return arr.map(String);
  }

  /** Detalle de varias tesis. Las que fallen vienen como `error`. */
  async tesis(ids: string[], concurrencia = 6): Promise<{ id: string; tesis?: TesisSjf; error?: string }[]> {
    const res = await this.getLote(
      ids.map((id) => `/tesis/${id}`),
      concurrencia
    );
    return res.map((r, i) => {
      const id = ids[i];
      if (r.status !== 200) return { id, error: `HTTP ${r.status}: ${r.cuerpo.slice(0, 100)}` };
      if (esReto(r.cuerpo)) return { id, error: "reto de Incapsula" };
      try {
        const t = JSON.parse(r.cuerpo) as TesisSjf;
        if (!t || typeof t.idTesis !== "number") return { id, error: "JSON sin idTesis" };
        return { id, tesis: t };
      } catch (e) {
        return { id, error: `JSON inválido: ${String(e).slice(0, 80)}` };
      }
    });
  }

  async cerrar(): Promise<void> {
    await this.browser.close().catch(() => {});
  }
}
