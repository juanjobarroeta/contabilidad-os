// ─────────────────────────────────────────────────────────────────────────────
// Carga el reporte «Existencia y Valuación» del hospital a HospInsumo/HospLote.
//
// Lo que esto trae y no había: EXISTENCIAS Y CADUCIDADES. HospLote estaba en
// cero, así que la farmacia no podía decir cuánto hay, dónde está ni qué está
// por vencerse — y el módulo entero (surtido, bajo mínimo, alerta de
// caducidad) depende de eso.
//
// NO TOCA el catálogo derivado de CFDIs. Esas 4,052 filas usan como clave el
// texto del renglón de la factura («CEFALOTINA», «7502009742101») y ninguna
// empata con las claves del hospital («MED00123»): son dos catálogos y
// fusionarlos a ciegas por nombre mete inventario en el insumo equivocado.
// Primero entra el catálogo de verdad; el emparejado es un pase aparte que una
// persona revisa.
//
// Uso:
//   npx tsx scripts/importar-inventario.ts <archivo.xls> --rfc RFC [--aplicar]
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import {
  caducidadDe,
  categoriaDeClave,
  parseInventario,
  valorLeido,
  type ArticuloListado,
} from "../src/lib/hospital/inventario-listado";

const mx = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

/** Un artículo sin lotes impresos igual tiene existencia: no se puede perder. */
const SIN_LOTE = "SIN_LOTE";

function lotesDe(a: ArticuloListado) {
  if (a.lotes.length === 0) {
    return [{ lote: SIN_LOTE, caducidad: null as Date | null, cantidad: a.existencia }];
  }
  return a.lotes.map((l) => ({
    lote: l.lote,
    caducidad: caducidadDe(l.caducidad),
    cantidad: l.cantidad ?? 0,
  }));
}

async function main() {
  const ruta = process.argv[2];
  const i = process.argv.indexOf("--rfc");
  const rfc = i > 0 ? process.argv[i + 1] : null;
  const aplicar = process.argv.includes("--aplicar");
  if (!ruta || !rfc) throw new Error("uso: importar-inventario.ts <archivo.xls> --rfc RFC [--aplicar]");

  const empresa = await prisma.company.findFirst({ where: { rfc }, select: { id: true, razonSocial: true } });
  if (!empresa) throw new Error(`empresa ${rfc} no encontrada`);

  const libro = XLSX.readFile(ruta);
  const filas = XLSX.utils.sheet_to_json<unknown[]>(libro.Sheets[libro.SheetNames[0]], { header: 1, blankrows: true, raw: true });
  const inv = parseInventario(filas);

  console.log(`${empresa.razonSocial} (${rfc})`);
  console.log(`${inv.articulos.length} renglones · ${new Set(inv.articulos.map((a) => a.clave)).size} claves · ${inv.almacenes.length} almacenes`);

  // LA VERIFICACIÓN QUE IMPORTA. El reporte imprime su propio total; si lo
  // leído no cuadra con él, el parser se comió renglones y nada de lo que siga
  // sirve. Se aborta antes de escribir.
  const leido = valorLeido(inv.articulos);
  console.log(`valor leído ${mx(leido)} · impreso ${inv.totalImpreso != null ? mx(inv.totalImpreso) : "—"}`);
  if (inv.totalImpreso != null && Math.abs(leido - inv.totalImpreso) > 0.5) {
    throw new Error(`La lectura no cuadra con el total del reporte (${mx(leido - inv.totalImpreso)} de diferencia). No se escribe nada.`);
  }
  console.log(aplicar ? "\nMODO: APLICAR\n" : "\nMODO: dry-run (no escribe nada)\n");

  // ── Insumos: uno por clave ────────────────────────────────────────────────
  const porClave = new Map<string, ArticuloListado>();
  for (const a of inv.articulos) if (!porClave.has(a.clave)) porClave.set(a.clave, a);

  const existentes = new Map(
    (await prisma.hospInsumo.findMany({ where: { companyId: empresa.id }, select: { id: true, clave: true } }))
      .map((x) => [x.clave.trim().toUpperCase(), x.id]),
  );

  const nuevos = [...porClave.values()].filter((a) => !existentes.has(a.clave.trim().toUpperCase()));
  console.log(`insumos: ${porClave.size} en el archivo · ${porClave.size - nuevos.length} ya existen · ${nuevos.length} nuevos`);

  const cat = new Map<string, number>();
  for (const a of porClave.values()) { const c = categoriaDeClave(a.clave); cat.set(c, (cat.get(c) ?? 0) + 1); }
  console.log(`  por categoría: ${[...cat].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  if (aplicar && nuevos.length) {
    for (let k = 0; k < nuevos.length; k += 500) {
      await prisma.hospInsumo.createMany({
        data: nuevos.slice(k, k + 500).map((a) => ({
          companyId: empresa.id,
          clave: a.clave,
          nombre: a.nombre,
          categoria: categoriaDeClave(a.clave),
          ultimoCosto: a.costoUnitario,
          // El catálogo del hospital, no uno derivado de facturas.
          derivadoDeCfdi: false,
        })),
        skipDuplicates: true,
      });
    }
    for (const x of await prisma.hospInsumo.findMany({ where: { companyId: empresa.id }, select: { id: true, clave: true } })) {
      existentes.set(x.clave.trim().toUpperCase(), x.id);
    }
    console.log(`  creados: ${nuevos.length}`);
  }

  // ── Lotes: uno por (insumo, lote, almacén) ────────────────────────────────
  type Fila = { insumoId: string; almacen: string; lote: string; caducidad: Date | null; existencia: number; costoUnitario: number };
  const porLlave = new Map<string, Fila>();
  let descuadre = 0;
  for (const a of inv.articulos) {
    // En dry-run los insumos nuevos todavía no tienen id; se usa uno ficticio
    // para poder CONTAR los lotes. Sin esto el ensayo decía «0 lotes» y
    // escondía justo la cifra que hay que revisar antes de escribir.
    const insumoId = existentes.get(a.clave.trim().toUpperCase()) ?? (aplicar ? null : `nuevo:${a.clave}`);
    if (!insumoId) continue;
    const suma = a.lotes.reduce((s, l) => s + (l.cantidad ?? 0), 0);
    if (a.lotes.length && Math.abs(suma - a.existencia) > 0.01) descuadre++;
    for (const l of lotesDe(a)) {
      // El mismo lote puede venir repetido dentro del almacén (dos ubicaciones):
      // se suman, que es lo que el conteo físico quiere decir.
      const llave = `${insumoId}|${l.lote}|${a.almacen}`;
      const prev = porLlave.get(llave);
      if (prev) prev.existencia += l.cantidad;
      else porLlave.set(llave, { insumoId, almacen: a.almacen, lote: l.lote, caducidad: l.caducidad, existencia: l.cantidad, costoUnitario: a.costoUnitario });
    }
  }

  const conCaducidad = [...porLlave.values()].filter((f) => f.caducidad);
  const hoy = new Date();
  const vencidos = conCaducidad.filter((f) => f.caducidad! < hoy);
  console.log(`\nlotes: ${porLlave.size} · con caducidad ${conCaducidad.length} · YA VENCIDOS ${vencidos.length}`);
  if (descuadre) console.log(`  ⚠ ${descuadre} artículos cuyos lotes no suman la existencia del renglón (se respeta lo que dice cada lote)`);
  for (const f of vencidos.slice(0, 8)) {
    console.log(`     ${f.lote.padEnd(16)} ${f.caducidad!.toISOString().slice(0, 10)}  ${f.existencia} pz  ${f.almacen}`);
  }

  if (aplicar) {
    const filasLote = [...porLlave.values()].map((f) => ({ companyId: empresa.id, ...f }));
    for (let k = 0; k < filasLote.length; k += 500) {
      await prisma.hospLote.createMany({ data: filasLote.slice(k, k + 500), skipDuplicates: true });
    }
    console.log(`  ESCRITOS: ${filasLote.length} lotes`);
  } else {
    console.log(`\n  (dry-run — con --aplicar se escribe)`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
