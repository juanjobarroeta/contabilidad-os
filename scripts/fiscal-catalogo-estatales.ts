// ─────────────────────────────────────────────────────────────────────────────
// Catálogo estatal/municipal CURADO A MANO → catalogo/estatales.json.
//
// El Orden Jurídico Nacional (fiscal-catalogo-ojn.ts) no tiene las leyes de
// varios estados (Morelos, Nuevo León, Sonora, Guanajuato… sólo publican
// acuerdos ahí) ni los códigos de construcción de muchos municipios. Lo que
// falta se busca en el congreso o el ayuntamiento y se anota en
// estatales.src.json con la URL verificada (curl 200 + PDF/Word real). Este
// script sólo le da forma de EntradaOjn (clave, materias, vigencia) para que
// ingest-leyes lo funda con el resto.
//
//   npx tsx scripts/fiscal-catalogo-estatales.ts
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { entradaDesde, type EntradaOjn } from "../src/lib/fiscal-kb/catalogo/ojn";

interface Fuente { entidad: string; municipio: string | null; tipo: string; titulo: string; url: string; ultimaReforma: string | null; verificado: string; reemplaza?: string[]; nota?: string }

const DIR = resolve(__dirname, "../src/lib/fiscal-kb/catalogo");
const src = JSON.parse(readFileSync(resolve(DIR, "estatales.src.json"), "utf8")) as { entradas: Fuente[] };

const entradas: (EntradaOjn & { reemplaza?: string[] })[] = [];
for (const [i, f] of src.entradas.entries()) {
  const e = entradaDesde(
    { idArchivo: `manual-${i + 1}`, titulo: f.titulo, fechaPublicacion: null, ultimaReforma: f.ultimaReforma, tipo: f.tipo },
    { sat: f.entidad, municipio: f.municipio },
    { url: f.url, estatus: "Vigente" },
  );
  // Vigencia: la ingesta lee «Última reforma publicada…» del texto; si el
  // documento no la trae y no se conoce la reforma, la fecha en que se verificó
  // que era el texto vigente es el respaldo honesto (vigente al menos desde ahí).
  e.vigenciaFallback = f.ultimaReforma ?? f.verificado;
  // La URL verificada puede no llevar extensión (p. ej. «/documentos/2795/download»):
  // el formato real se detecta por bytes al ingerir (texto.ts), así que no se excluye.
  if (e.excluida?.startsWith("Formato")) e.excluida = null;
  for (const otra of entradas) if (otra.clave === e.clave) e.clave = `${e.clave}-${i + 1}`;
  // Claves del OJN que este texto sustituye (una ley nueva que abrogó a la que el
  // OJN sigue listando): ingest-leyes las saca del catálogo.
  entradas.push(f.reemplaza?.length ? { ...e, reemplaza: f.reemplaza } : e);
}
const salida = resolve(DIR, "estatales.json");
writeFileSync(salida, JSON.stringify({ fuente: "estatales.src.json (curado a mano)", generado: new Date().toISOString().slice(0, 10), entradas: entradas.sort((a, b) => a.clave.localeCompare(b.clave)) }, null, 2) + "\n");
console.log(`✓ ${salida}\n  ${entradas.length} entradas (${entradas.filter((e) => !e.excluida).length} ingeribles)`);
