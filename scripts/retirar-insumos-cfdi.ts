// ─────────────────────────────────────────────────────────────────────────────
// Retira el catálogo de farmacia que nació de los CFDIs (derivadoDeCfdi) ahora
// que «la recepción manda» y el inventario de verdad es el físico.
//
//   • Remapea las líneas de requisición (SolicitudPartida.hospInsumoId) que
//     apuntan a un derivado hacia el insumo físico con la misma clave o el
//     mismo nombre normalizado. Ambiguo o sin candidato → no se toca.
//   • Desactiva (activo = false) los derivados sin lotes con existencia, sin
//     movimientos que no sean del CFDI y sin otras referencias.
// NUNCA borra insumos ni movimientos: el kardex derivado se queda como
// historia, colgado de un insumo inactivo. La selección vive en
// src/lib/hospital/retiro-derivados.ts (con pruebas).
//
// Uso:
//   npx tsx scripts/retirar-insumos-cfdi.ts --company <RFC>                    # en seco (default)
//   npx tsx scripts/retirar-insumos-cfdi.ts --company <RFC> --apply --salida reversion.json
//   npx tsx scripts/retirar-insumos-cfdi.ts --company <RFC> --revertir reversion.json
//   [--detalle N]  cuántas filas imprimir por sección (default 30)
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
  planRetiro,
  validarArchivoReversion,
  type ArchivoReversion,
  type Derivado,
} from "../src/lib/hospital/retiro-derivados";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};

const TIPOS_CFDI = ["ENTRADA_COMPRA", "SALIDA_VENTA"] as const;

async function contarPor(ids: string[], fn: (ids: string[]) => Promise<Array<{ id: string | null; n: number }>>) {
  const m = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 5_000) {
    for (const r of await fn(ids.slice(i, i + 5_000))) if (r.id) m.set(r.id, (m.get(r.id) ?? 0) + r.n);
  }
  return m;
}

async function cargarDerivados(companyId: string): Promise<Derivado[]> {
  const base = await prisma.hospInsumo.findMany({
    where: { companyId, derivadoDeCfdi: true, activo: true },
    select: { id: true, clave: true, nombre: true },
    orderBy: { clave: "asc" },
  });
  const ids = base.map((b) => b.id);
  const g = <T extends { _count: { _all: number } }>(rows: T[], k: keyof T) => rows.map((r) => ({ id: r[k] as unknown as string | null, n: r._count._all }));

  const [lotes, movs, protocolos, codigos, conteos, area, cfdiLineas, claves, partidas] = await Promise.all([
    contarPor(ids, async (x) => g(await prisma.hospLote.groupBy({ by: ["insumoId"], where: { insumoId: { in: x }, existencia: { gt: 0 } }, _count: { _all: true } }), "insumoId")),
    contarPor(ids, async (x) =>
      g(
        await prisma.hospMovimientoInsumo.groupBy({
          by: ["insumoId"],
          where: { insumoId: { in: x }, OR: [{ invoiceId: null }, { loteId: { not: null } }, { tipo: { notIn: [...TIPOS_CFDI] } }] },
          _count: { _all: true },
        }),
        "insumoId"
      )
    ),
    contarPor(ids, async (x) => g(await prisma.hospProtocoloInsumo.groupBy({ by: ["insumoId"], where: { insumoId: { in: x } }, _count: { _all: true } }), "insumoId")),
    contarPor(ids, async (x) => g(await prisma.hospCodigoBarras.groupBy({ by: ["insumoId"], where: { insumoId: { in: x } }, _count: { _all: true } }), "insumoId")),
    contarPor(ids, async (x) => g(await prisma.hospConteoLinea.groupBy({ by: ["insumoId"], where: { insumoId: { in: x } }, _count: { _all: true } }), "insumoId")),
    contarPor(ids, async (x) => g(await prisma.hospSolicitudAreaLinea.groupBy({ by: ["hospInsumoId"], where: { hospInsumoId: { in: x } }, _count: { _all: true } }), "hospInsumoId")),
    contarPor(ids, async (x) => g(await prisma.hospCfdiLinea.groupBy({ by: ["insumoId"], where: { insumoId: { in: x } }, _count: { _all: true } }), "insumoId")),
    contarPor(ids, async (x) => g(await prisma.hospProveedorInsumo.groupBy({ by: ["insumoId"], where: { insumoId: { in: x } }, _count: { _all: true } }), "insumoId")),
    prisma.solicitudPartida.findMany({
      // Una requisición cancelada o rechazada (lo que la UI llama «eliminar»)
      // ya no recibe nada: no detiene el retiro ni se remapea.
      where: { hospInsumoId: { in: ids }, solicitud: { estado: { notIn: ["CANCELADA", "RECHAZADA"] } } },
      select: { id: true, descripcion: true, hospInsumoId: true, solicitud: { select: { folio: true } } },
    }),
  ]);

  const partidasDe = new Map<string, Derivado["partidas"]>();
  for (const p of partidas) {
    const l = partidasDe.get(p.hospInsumoId!) ?? [];
    l.push({ id: p.id, descripcion: p.descripcion, folio: p.solicitud.folio });
    partidasDe.set(p.hospInsumoId!, l);
  }
  return base.map((b) => ({
    ...b,
    lotesConExistencia: lotes.get(b.id) ?? 0,
    movimientosNoCfdi: movs.get(b.id) ?? 0,
    referencias: {
      protocolos: protocolos.get(b.id) ?? 0,
      codigosBarras: codigos.get(b.id) ?? 0,
      conteoLineas: conteos.get(b.id) ?? 0,
      lineasArea: area.get(b.id) ?? 0,
      cfdiLineas: cfdiLineas.get(b.id) ?? 0,
      proveedorClaves: claves.get(b.id) ?? 0,
    },
    partidas: partidasDe.get(b.id) ?? [],
  }));
}

async function revertir(companyId: string, ruta: string) {
  const a = validarArchivoReversion(JSON.parse(readFileSync(ruta, "utf8")));
  if (a.companyId !== companyId) throw new Error(`El archivo es de otra empresa (${a.rfc})`);
  const r = await prisma.$transaction(async (tx) => {
    let partidas = 0;
    for (const m of a.remapeos) {
      // Sólo si nadie la volvió a mover desde entonces.
      const { count } = await tx.solicitudPartida.updateMany({ where: { id: m.partidaId, hospInsumoId: m.a }, data: { hospInsumoId: m.de } });
      partidas += count;
    }
    const { count: insumos } = await tx.hospInsumo.updateMany({
      where: { id: { in: a.desactivados }, companyId, derivadoDeCfdi: true, activo: false },
      data: { activo: true },
    });
    return { partidas, insumos };
  });
  console.log(`✓ revertido: ${r.partidas}/${a.remapeos.length} líneas de requisición regresadas · ${r.insumos}/${a.desactivados.length} insumos reactivados`);
}

async function main() {
  const rfc = arg("--company");
  const aplicar = process.argv.includes("--apply");
  const salida = arg("--salida");
  const rutaRevertir = arg("--revertir");
  const detalle = Number(arg("--detalle") ?? 30);
  if (!rfc) throw new Error("uso: retirar-insumos-cfdi.ts --company <RFC> [--apply --salida <archivo.json>] [--revertir <archivo.json>]");
  if (aplicar && rutaRevertir) throw new Error("--apply y --revertir no van juntos");
  if (aplicar && !salida) throw new Error("--apply exige --salida <archivo.json> (la reversión)");
  if (aplicar && salida && existsSync(salida)) throw new Error(`${salida} ya existe: no se sobreescribe una reversión`);

  const empresa = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!empresa) throw new Error(`empresa ${rfc} no encontrada`);
  console.log(`\n${empresa.razonSocial} (${rfc.toUpperCase()})`);

  if (rutaRevertir) return revertir(empresa.id, rutaRevertir);

  const cfg = await prisma.hospConfig.findUnique({ where: { companyId: empresa.id }, select: { cfdiCreaInventario: true } });
  if (cfg?.cfdiCreaInventario) {
    throw new Error("La empresa sigue con cfdiCreaInventario = true: el CFDI volvería a crear los insumos. Apágalo primero en Configuración.");
  }

  const [derivados, catalogo] = await Promise.all([
    cargarDerivados(empresa.id),
    prisma.hospInsumo.findMany({ where: { companyId: empresa.id, derivadoDeCfdi: false, activo: true }, select: { id: true, clave: true, nombre: true } }),
  ]);
  const plan = planRetiro(derivados, catalogo);
  const c = plan.conteos;

  console.log(`\nCatálogo físico activo: ${catalogo.length} · derivados activos: ${c.derivados}`);
  console.log(`\n(a) Líneas de requisición que apuntan a un derivado: ${c.partidas}`);
  console.log(`    remapeables ${c.remapeables} · ambiguas ${c.ambiguas} · sin candidato ${c.sinCandidato}`);
  for (const r of plan.remapeos.slice(0, detalle)) {
    const destino = r.propuesto ? `→ ${r.propuesto.clave} «${r.propuesto.nombre}» (por ${r.motivo})` : `✗ ${r.motivo}${r.candidatos > 1 ? ` (${r.candidatos} candidatos)` : ""}`;
    console.log(`    ${r.folio ?? "—"} · «${r.descripcion}» [derivado «${r.derivadoNombre}»] ${destino}`);
  }
  console.log(`\n(b) Derivados a desactivar: ${c.desactivar} · se quedan: ${c.retenidos}`);
  for (const d of plan.desactivar.slice(0, detalle)) console.log(`    − ${d.clave} «${d.nombre}»`);
  if (plan.desactivar.length > detalle) console.log(`    … y ${plan.desactivar.length - detalle} más`);
  if (plan.retenidos.length) {
    console.log(`\n    Se quedan activos:`);
    for (const r of plan.retenidos.slice(0, detalle)) console.log(`    · ${r.clave} «${r.nombre}»: ${r.razones.join("; ")}`);
    if (plan.retenidos.length > detalle) console.log(`    … y ${plan.retenidos.length - detalle} más`);
  }

  if (!aplicar) {
    console.log(`\nEn seco: no se escribió nada. Para aplicar: --apply --salida <archivo.json>`);
    return;
  }

  const remapeos = plan.remapeos.filter((r) => r.propuesto).map((r) => ({ partidaId: r.partidaId, de: r.derivadoId, a: r.propuesto!.id }));
  const desactivados = plan.desactivar.map((d) => d.id);
  const reversion: ArchivoReversion = {
    version: 1,
    companyId: empresa.id,
    rfc: rfc.toUpperCase(),
    aplicadoAt: new Date().toISOString(),
    remapeos,
    desactivados,
  };
  // La reversión se escribe ANTES de tocar la base: si algo truena a medias, ya existe.
  writeFileSync(salida!, JSON.stringify(reversion, null, 2));

  const r = await prisma.$transaction(
    async (tx) => {
      let partidas = 0;
      for (const m of remapeos) {
        const { count } = await tx.solicitudPartida.updateMany({ where: { id: m.partidaId, hospInsumoId: m.de }, data: { hospInsumoId: m.a } });
        partidas += count;
      }
      let insumos = 0;
      for (let i = 0; i < desactivados.length; i += 1_000) {
        const { count } = await tx.hospInsumo.updateMany({
          where: { id: { in: desactivados.slice(i, i + 1_000) }, companyId: empresa.id, derivadoDeCfdi: true, activo: true },
          data: { activo: false },
        });
        insumos += count;
      }
      return { partidas, insumos };
    },
    { timeout: 120_000 }
  );
  console.log(`\n✓ aplicado: ${r.partidas} líneas remapeadas · ${r.insumos} insumos desactivados`);
  console.log(`  reversión: ${salida} (npx tsx scripts/retirar-insumos-cfdi.ts --company ${rfc.toUpperCase()} --revertir ${salida})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
