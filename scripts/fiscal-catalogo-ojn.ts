/**
 * Catálogo estatal y municipal de construcción y desarrollo urbano desde el
 * Orden Jurídico Nacional (SEGOB) → src/lib/fiscal-kb/catalogo/ojn.json.
 *
 *   npm run fiscal:catalogo-ojn                       # 32 estados + capitales y ciudades principales
 *   npm run fiscal:catalogo-ojn -- --estados 21,9     # sólo Puebla y CDMX
 *   npm run fiscal:catalogo-ojn -- --municipios todos # TODOS los municipios de los estados elegidos (lento)
 *   npm run fiscal:catalogo-ojn -- --sin-filtro       # todo lo normativo (ley/código/reglamento), no sólo construcción
 *
 * Es un crawler cortés: secuencial por página, ~4 req/s, y reintenta. Entra por PR.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  ESTADOS,
  MUNICIPIOS_PRINCIPALES,
  OJN_BASE,
  entradaDesde,
  esCodigoDeLitigio,
  esNormativoDeConstruccion,
  parsearFicha,
  parsearListado,
  parsearSelectores,
  type EntradaOjn,
  type OrdenamientoOjn,
} from "../src/lib/fiscal-kb/catalogo/ojn";

const SALIDA = resolve(__dirname, "../src/lib/fiscal-kb/catalogo/ojn.json");
const UA = { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)" };
const TIPOS_NORMATIVOS = ["Ley", "Código", "Reglamento"];

async function html(url: string, init: RequestInit = {}): Promise<string> {
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) } });
      if (res.ok) return new TextDecoder("iso-8859-1").decode(new Uint8Array(await res.arrayBuffer()));
      if (intento >= 3) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (intento >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * intento));
  }
}
const HOY = new Date().toISOString().slice(0, 10);
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

// El sitio a veces contesta 200 con una página vacía (sin filas) bajo carga:
// Sonora y Guanajuato salieron con 0 y 4 filas en una corrida y con 73 y 637 en
// la siguiente. Un listado vacío se vuelve a pedir dos veces antes de creerlo.
async function listado(url: string, init: RequestInit = {}) {
  let filas = parsearListado(await html(url, init));
  for (let intento = 1; filas.length === 0 && intento <= 2; intento++) {
    await pausa(2000 * intento);
    filas = parsearListado(await html(url, init));
  }
  return filas;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => (args.indexOf(k) !== -1 ? args[args.indexOf(k) + 1] : undefined);
  const estadosSel = arg("--estados")?.split(",").map(Number);
  const todosMunicipios = arg("--municipios") === "todos";
  const sinFiltro = args.includes("--sin-filtro");
  // --codigos: los códigos estatales que un litigante usa (civil, procedimientos,
  // familiar, penal, fiscal, administrativo, justicia…), sólo nivel estatal.
  const soloCodigos = args.includes("--codigos");
  const estados = ESTADOS.filter((e) => !estadosSel || estadosSel.includes(e.id));

  // Reanudable: lo ya resuelto (por idArchivo) no vuelve a pedir su ficha.
  const previo: EntradaOjn[] = existsSync(SALIDA) ? (JSON.parse(readFileSync(SALIDA, "utf8")) as { entradas: EntradaOjn[] }).entradas : [];
  // Sólo se reutilizan las fichas que dieron archivo: las que no, se vuelven a pedir
  // (el parser puede haber mejorado, o el sitio haber subido el archivo).
  const fichas = new Map(previo.filter((e) => e.url).map((e) => [e.idArchivo, { url: e.url, estatus: null as string | null }]));
  const entradas = new Map<string, EntradaOjn>(previo.map((e) => [e.idArchivo, e]));

  const filtro = (o: OrdenamientoOjn) => (soloCodigos ? esCodigoDeLitigio(o) : sinFiltro ? /^(Ley|C[óo]digo|Reglamento)/i.test(o.tipo) : esNormativoDeConstruccion(o));
  const resolver = async (o: OrdenamientoOjn, ctx: { sat: string; municipio: string | null }, ambito: "ESTATAL" | "MUNICIPAL") => {
    let archivo = fichas.get(o.idArchivo);
    if (!archivo) {
      archivo = parsearFicha(await html(`${OJN_BASE}/fichaOrdenamiento.php?idArchivo=${o.idArchivo}&ambito=${ambito}`));
      fichas.set(o.idArchivo, archivo);
      await pausa(250);
    }
    const e = entradaDesde(o, ctx, archivo, { forzarConstruccion: !soloCodigos && !sinFiltro });
    // Misma clave para dos ordenamientos distintos: se distingue por idArchivo.
    for (const otra of entradas.values()) if (otra.clave === e.clave && otra.idArchivo !== e.idArchivo) e.clave = `${e.clave}-${e.idArchivo}`;
    // Sin fecha de publicación ni reforma (el OJN pone 00-00-0000): la ingesta
    // lee la fecha del texto y, si tampoco la trae, vale la del rastreo — el
    // texto estaba vigente al menos ese día.
    if (!e.vigenciaFallback) e.vigenciaFallback = HOY;
    entradas.set(o.idArchivo, e);
  };

  for (const edo of estados) {
    const t0 = Date.now();
    let est = 0;
    let mun = 0;
    // Estatal: los cuatro poderes.
    for (const poder of [1, 2, 3, 4]) {
      const lista = await listado(`${OJN_BASE}/despliegaedo.php?edo=${edo.id}&idPoder=${poder}&liberado=No`);
      for (const o of lista.filter(filtro)) {
        await resolver(o, { sat: edo.sat, municipio: null }, "ESTATAL");
        est++;
      }
      await pausa(300);
    }
    // Municipal: capital + principales (o todos).
    const sel = soloCodigos ? { tipos: {}, municipios: [] } : parsearSelectores(await html(`${OJN_BASE}/estatal.php?liberado=no&edo=${edo.id}`));
    const tipoIds = TIPOS_NORMATIVOS.map((t) => sel.tipos[t]).filter(Boolean);
    const quiero = new Set([edo.capital, ...(MUNICIPIOS_PRINCIPALES[edo.sat] ?? [])].map((m) => m.toLowerCase()));
    const municipios = sel.municipios.filter((m) => todosMunicipios || quiero.has(m.nombre.toLowerCase()));
    for (const m of municipios) {
      for (const idTipo of tipoIds) {
        const body = new URLSearchParams({ idEstado: String(edo.id), idMunicipio: m.id, idTipo });
        const lista = await listado(`${OJN_BASE}/obtenerOrdenamientosMu.php`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        for (const o of lista.filter(filtro)) {
          await resolver(o, { sat: edo.sat, municipio: m.nombre }, "MUNICIPAL");
          mun++;
        }
        await pausa(250);
      }
    }
    console.log(`${edo.sat} ${edo.nombre}: ${est} estatales, ${mun} municipales (${municipios.length} municipios: ${municipios.map((x) => x.nombre).join(", ")}) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    writeFileSync(SALIDA, JSON.stringify({ fuente: OJN_BASE, generado: new Date().toISOString().slice(0, 10), entradas: [...entradas.values()].sort((a, b) => a.clave.localeCompare(b.clave)) }, null, 2) + "\n");
  }
  const todas = [...entradas.values()];
  console.log(`✓ ${SALIDA}\n  ${todas.length} entradas (${todas.filter((e) => !e.excluida).length} ingeribles; ${todas.filter((e) => e.ambito === "MUNICIPAL").length} municipales)`);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
