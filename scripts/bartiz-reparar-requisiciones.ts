/**
 * Reparación de las requisiciones históricas de BARTIZ (CBA170606FQ8).
 *
 * Contexto: el formulario de requisiciones de bartiz tenía las columnas
 * «Cantidad» y «Unidad» desalineadas (arreglado en bartiz PR #69), así que
 * el residente capturó el PRECIO en cantidad y la CANTIDAD en el precio de
 * la cotización. Además cada requisición trae UNA sola cotización (no hubo
 * concurso) y ya está pagada en la realidad, pero quedó PENDIENTE sin
 * adjudicar, así que no cuenta como costo del proyecto.
 *
 * Fases (se corren en este orden; `todo` las encadena):
 *   proveedores — unifica nombres (variantes de la misma persona) y liga
 *                 supplierId cuando el nombre coincide con un Supplier.
 *                 Lista los nombres sin Supplier (hace falta RFC).
 *   swap        — intercambia partida.cantidad ↔ cotización.precioUnitario,
 *                 separa «8 PZA» en cantidad + unidad, recalcula importes y
 *                 fija el IVA de la línea:
 *                   · nota explícita «el precio/costo es sin IVA» + proveedor
 *                     formal (con RFC, o S.A./S. de R.L./LAMONT/TEPSA)
 *                     ⇒ 16 % (cotización formal, se factura).
 *                   · «INCLUYE IVA» ⇒ precio ÷ 1.16 y 16 %.
 *                   · todo lo demás (gasolina, peajes, pagos a personas, un
 *                     «SIN IVA» suelto) ⇒ sin IVA: lo capturado es lo que se
 *                     desembolsó. Al ligar el CFDI se podrá corregir.
 *   cerrar      — selecciona la única cotización, APRUEBA (adjudicaciones
 *                 reales con IVA por línea) y registra el PAGO por el total
 *                 con fecha de captura ⇒ requisición PAGADA, costo del
 *                 proyecto en comprometido y pagadoReal.
 *
 * Seguridad: dry-run por defecto. `--aplicar` escribe. `--hasta=<ISO>`
 * limita a requisiciones creadas antes de esa fecha (default: ahora; usar
 * la hora del deploy de bartiz PR #69 si siguieron capturando con el
 * formulario viejo). El libro local `.bartiz-reparacion.json` evita hacer
 * el swap dos veces sobre la misma requisición.
 *
 * Correr:  DATABASE_URL=... npx tsx scripts/bartiz-reparar-requisiciones.ts --fase=todo [--aplicar] [--hasta=2026-10-03T00:00:00Z]
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { generateAdjudicaciones } from "@/lib/construccion/adjudicaciones";
import { aplicarPago } from "@/lib/construccion/pagos-proveedor";

const prisma = new PrismaClient();

const BARTIZ_RFC = "CBA170606FQ8";
const LEDGER = path.join(__dirname, ".bartiz-reparacion.json");
const REFERENCIA_PAGO = "Carga histórica Bartiz (requisición ya pagada al capturarse)";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const money = (n: number) =>
  n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Variantes del mismo proveedor capturadas a mano → nombre canónico.
// ALFREDO ITZCOATL COYOTL se deja aparte: apellido distinto (Coyotl ≠ Chantes).
const NOMBRES_CANONICOS: Record<string, string> = {
  "ALFREDO ITZCOATL": "JOSE ALFREDO ITZCOATL CHANTES",
  "ALFREDO ITZCOATL CHANTES": "JOSE ALFREDO ITZCOATL CHANTES",
  "JOSE ALFREDO ITZCOATL": "JOSE ALFREDO ITZCOATL CHANTES",
  "JOSE ALFREDO IZCOATL CHANTES": "JOSE ALFREDO ITZCOATL CHANTES",
  "DIEGON MIXCOATL COYOTL": "DIEGO MIXCOATL COYOTL",
  "MATERIAL PARA CONSTRUCCION SAN FRANCISCO": "MATERIALES PARA CONSTRUCCION SAN FRANCISCO",
  "FC MATERIALES SA DE CV": "FERRECENTRO FC MATERIALES",
};

// Líneas que el residente SÍ capturó bien (cantidad chica, precio grande) y
// que el swap rompería. Se identifican por folio + descripción.
const CONSERVAR = new Set<string>([
  "REQ-20260922-DCE|ROLLO ZETALUM C20X36´ IMPORTACION", // 27 rollos @ 4,290 / 4,530
  "REQ-20260923-OMY|SUMINISTRO Y ROLADO DE LAMINA ZINTRO-ALUM CALIBRE 20.", // 2,500 kg @ 33.60
]);

// Combustible despachado: la bomba da litros con 3 decimales (21.286 L) y el
// precio por litro es mayor que los litros ⇒ ya está bien capturado.
function esCombustibleBien(unidad: string | null, cantidad: number, precio: number) {
  if (!unidad || !/^(L|LT|LTS|LITRO|LITROS)$/i.test(unidad.trim())) return false;
  const decimales = (String(cantidad).split(".")[1] ?? "").length;
  return decimales >= 3 && precio > cantidad;
}

// «EL PRECIO ES SIN IVA», «LOS PRECIOS SON SIN IVA», «EL COSTO (ES|NO INCLUYE) SIN IVA»:
// el residente afirma que la cifra excluye IVA. Un «SIN IVA» a secas no cuenta.
const NOTA_EXCLUYE_IVA = /(PRECIO|COSTO)S?\s+(ES|SON|NO\s+INCLUYE)?\s*(SIN|NO\s+INCLUYE)\s+IVA/i;
const NOTA_INCLUYE_IVA = /INCLUYE\s+IVA/i;
// Proveedores formales (facturan) que todavía no tienen Supplier/RFC en el sistema.
const FORMAL_SIN_RFC = /S\.?\s?A\.?\s?(DE\s?C\.?V\.?)?$|S\.?\s?DE\s?R\.?L\.?|^LAMONT$|^TEPSA\b/i;

function canonico(nombre: string) {
  const n = nombre.trim();
  return NOMBRES_CANONICOS[n.toUpperCase()] ?? n;
}

async function suppliersPorNombre(cid: string) {
  const suppliers = await prisma.supplier.findMany({
    where: { companyId: cid },
    select: { id: true, rfc: true, razonSocial: true },
  });
  return new Map(suppliers.map((s) => [s.razonSocial.trim().toUpperCase(), s]));
}

type Args = { fase: string; aplicar: boolean; hasta: Date };

function parseArgs(): Args {
  const get = (k: string) =>
    process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const fase = get("fase") ?? "todo";
  const aplicar = process.argv.includes("--aplicar");
  const hasta = get("hasta") ? new Date(get("hasta")!) : new Date();
  if (Number.isNaN(hasta.getTime())) throw new Error("--hasta inválida");
  return { fase, aplicar, hasta };
}

function leerLibro(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf8")).swapped as string[]);
  } catch {
    return new Set();
  }
}
function guardarLibro(ids: Set<string>) {
  fs.writeFileSync(LEDGER, JSON.stringify({ swapped: [...ids] }, null, 2));
}

async function companyId(): Promise<string> {
  const c = await prisma.company.findUnique({ where: { rfc: BARTIZ_RFC }, select: { id: true } });
  if (!c) throw new Error(`No existe la empresa ${BARTIZ_RFC}`);
  return c.id;
}

// Requisiciones objetivo: capturadas desde bartiz (REQ-…), aún PENDIENTES,
// creadas antes del corte.
async function requisicionesObjetivo(cid: string, hasta: Date) {
  return prisma.solicitudCompra.findMany({
    where: {
      companyId: cid,
      estado: "PENDIENTE",
      folio: { startsWith: "REQ-" },
      createdAt: { lte: hasta },
    },
    orderBy: { createdAt: "asc" },
    include: {
      proyecto: { select: { codigo: true } },
      partidas: { include: { cotizaciones: true } },
      cotizaciones: { include: { partidas: true } },
    },
  });
}

type Req = Awaited<ReturnType<typeof requisicionesObjetivo>>[number];

function unicaCotizacion(r: Req) {
  if (r.cotizaciones.length !== 1) return null;
  const cot = r.cotizaciones[0];
  const cubiertas = new Set(cot.partidas.map((p) => p.solicitudPartidaId));
  if (!r.partidas.every((p) => cubiertas.has(p.id))) return null;
  return cot;
}

// «8 PZA» → { cantidad: 8, unidad: "PZA" }. Sólo si el número coincide con
// la cantidad real; «544.12KG» (peso por pieza) se deja tal cual.
function separarUnidad(unidad: string | null, cantidad: number) {
  if (!unidad) return unidad;
  const m = unidad.trim().match(/^(\d+(?:[.,]\d+)?)\s*([A-Za-zÁ-ÿ.]+)$/);
  if (!m) return unidad;
  const n = Number(m[1].replace(",", "."));
  if (Math.abs(n - cantidad) > 0.0001) return unidad;
  return m[2].toUpperCase();
}

// ───────────────────────── fase: swap ─────────────────────────
async function faseSwap(cid: string, a: Args) {
  const libro = leerLibro();
  const porNombre = await suppliersPorNombre(cid);
  const reqs = await requisicionesObjetivo(cid, a.hasta);
  console.log(`\n=== SWAP cantidad ↔ precio + IVA por línea (${reqs.length} requisiciones PENDIENTES REQ-*, hasta ${a.hasta.toISOString()})`);

  const omitidas: string[] = [];
  let lineas = 0;
  const resumenIva = { conIva: { reqs: 0, subtotal: 0, iva: 0 }, sinIva: { reqs: 0, subtotal: 0 } };
  const proveedoresConIva = new Map<string, number>();
  for (const r of reqs) {
    if (libro.has(r.id)) {
      omitidas.push(`${r.folio}: ya reparada (libro local)`);
      continue;
    }
    const cot = unicaCotizacion(r);
    if (!cot) {
      omitidas.push(`${r.folio}: ${r.cotizaciones.length} cotizaciones / partidas sin cotizar — no se toca`);
      continue;
    }
    const incluyeIva = NOTA_INCLUYE_IVA.test(r.notas ?? "");
    const tieneRfc = !!cot.supplierId || porNombre.has(canonico(cot.supplierNombre).toUpperCase());
    const formal = tieneRfc || FORMAL_SIN_RFC.test(canonico(cot.supplierNombre));
    const excluyeIva = NOTA_EXCLUYE_IVA.test(r.notas ?? "") && formal;
    const ivaTasa: number | null = incluyeIva || excluyeIva ? 0.16 : null;
    console.log(
      `\n${r.folio}  [${r.proyecto?.codigo ?? "sin proyecto"}]  ${cot.supplierNombre}${tieneRfc ? " (RFC)" : ""}  ` +
        `${r.notas ? `«${r.notas}»` : ""}  → ${ivaTasa == null ? "SIN IVA" : "IVA 16 %"}`
    );

    const updates: Prisma.PrismaPromise<unknown>[] = [];
    let totalCot = 0;
    for (const p of r.partidas) {
      const cp = p.cotizaciones.find((x) => x.cotizacionId === cot.id)!;
      const capQty = Number(p.cantidad);
      const capPrecio = Number(cp.precioUnitario);
      const conservar =
        CONSERVAR.has(`${r.folio}|${p.descripcion.trim()}`) || esCombustibleBien(p.unidad, capQty, capPrecio);
      // Por default la línea viene al revés: lo capturado como «precio» era la
      // cantidad y lo capturado como «cantidad» era el precio.
      const cantidadNueva = conservar ? capQty : capPrecio;
      let precioNuevo = conservar ? capPrecio : capQty;
      if (incluyeIva) precioNuevo = round4(precioNuevo / 1.16);
      const importe = round2(cantidadNueva * precioNuevo);
      const unidadNueva = separarUnidad(p.unidad, cantidadNueva);
      totalCot += importe;
      lineas++;

      console.log(
        `   ${p.descripcion.slice(0, 44).padEnd(44)} ` +
          `antes ${Number(p.cantidad)} ${p.unidad ?? ""} @ ${money(Number(cp.precioUnitario))}  →  ` +
          `${cantidadNueva} ${unidadNueva ?? ""} @ ${money(precioNuevo)} = ${money(importe)}` +
          (incluyeIva ? "  (÷1.16)" : "") +
          (conservar ? "  (SE CONSERVA)" : "")
      );

      updates.push(
        prisma.solicitudPartida.update({
          where: { id: p.id },
          data: { cantidad: cantidadNueva, unidad: unidadNueva, precioUnitario: precioNuevo, importe, ivaTasa },
        }),
        prisma.solicitudCotizacionPartida.update({
          where: { id: cp.id },
          data: { precioUnitario: precioNuevo, importe },
        })
      );
    }
    totalCot = round2(totalCot);
    console.log(`   total cotización ${money(Number(cot.total))} → ${money(totalCot)}`);
    if (ivaTasa == null) {
      resumenIva.sinIva.reqs++;
      resumenIva.sinIva.subtotal += totalCot;
    } else {
      resumenIva.conIva.reqs++;
      resumenIva.conIva.subtotal += totalCot;
      resumenIva.conIva.iva += round2(totalCot * 0.16);
      const k = canonico(cot.supplierNombre);
      proveedoresConIva.set(k, (proveedoresConIva.get(k) ?? 0) + totalCot);
    }
    updates.push(
      prisma.solicitudCompraCotizacion.update({ where: { id: cot.id }, data: { total: totalCot } })
    );

    if (a.aplicar) {
      await prisma.$transaction(updates);
      libro.add(r.id);
      guardarLibro(libro);
    }
  }
  console.log(`\n${lineas} líneas ${a.aplicar ? "reparadas" : "por reparar"}; omitidas: ${omitidas.length}`);
  for (const o of omitidas) console.log("   - " + o);
  console.log(
    `\nIVA: ${resumenIva.conIva.reqs} requisiciones con 16 % (subtotal $${money(round2(resumenIva.conIva.subtotal))}, IVA $${money(round2(resumenIva.conIva.iva))}); ` +
      `${resumenIva.sinIva.reqs} sin IVA ($${money(round2(resumenIva.sinIva.subtotal))})`
  );
  console.log("Proveedores a los que se les aplica IVA:");
  for (const [n, t] of [...proveedoresConIva].sort((x, y) => y[1] - x[1])) {
    console.log(`   ${n.padEnd(50)} $${money(round2(t))}`);
  }
}

// ───────────────────────── fase: proveedores ─────────────────────────
async function faseProveedores(cid: string, a: Args) {
  console.log(`\n=== PROVEEDORES`);
  const porNombre = await suppliersPorNombre(cid);

  const cots = await prisma.solicitudCompraCotizacion.findMany({
    where: { solicitud: { companyId: cid } },
    select: { id: true, supplierId: true, supplierNombre: true, total: true, solicitud: { select: { folio: true } } },
  });

  let renombradas = 0;
  let ligadas = 0;
  const sinSupplier = new Map<string, { n: number; total: number }>();
  for (const c of cots) {
    const original = c.supplierNombre.trim();
    const canon = canonico(original);
    const sup = porNombre.get(canon.toUpperCase());
    const data: Prisma.SolicitudCompraCotizacionUpdateInput = {};
    if (canon !== original) {
      data.supplierNombre = canon;
      renombradas++;
      console.log(`   ${c.solicitud.folio}: «${original}» → «${canon}»`);
    }
    if (sup && c.supplierId !== sup.id) {
      data.supplier = { connect: { id: sup.id } };
      ligadas++;
    }
    if (!sup) {
      const e = sinSupplier.get(canon) ?? { n: 0, total: 0 };
      e.n++;
      e.total += Number(c.total);
      sinSupplier.set(canon, e);
    }
    if (a.aplicar && Object.keys(data).length > 0) {
      await prisma.solicitudCompraCotizacion.update({ where: { id: c.id }, data });
    }
  }
  console.log(`\n${renombradas} nombres unificados, ${ligadas} cotizaciones ligadas a un Supplier existente.`);
  console.log(`\nNombres SIN Supplier (hace falta RFC para darlos de alta):`);
  for (const [nombre, e] of [...sinSupplier].sort((x, y) => y[1].total - x[1].total)) {
    console.log(`   ${nombre.padEnd(50)} ${String(e.n).padStart(3)} cot.  $${money(e.total)}`);
  }
}

// ───────────────────────── fase: cerrar ─────────────────────────
async function faseCerrar(cid: string, a: Args) {
  const reqs = await requisicionesObjetivo(cid, a.hasta);
  console.log(`\n=== CERRAR: seleccionar única cotización → APROBADA → PAGADA (${reqs.length} candidatas)`);

  let cerradas = 0;
  let totalPagado = 0;
  const omitidas: string[] = [];
  for (const r of reqs) {
    const cot = unicaCotizacion(r);
    if (!cot) {
      omitidas.push(`${r.folio}: sin cotización única`);
      continue;
    }
    const fecha = r.createdAt; // la captura se hizo ya pagado: la fecha real más cercana
    const subtotal = round2(cot.partidas.reduce((s, cp) => s + Number(cp.importe), 0));
    const iva = round2(
      r.partidas.reduce((s, p) => {
        const cp = cot.partidas.find((x) => x.solicitudPartidaId === p.id)!;
        return s + round2(Number(cp.importe) * (p.ivaTasa == null ? 0 : Number(p.ivaTasa)));
      }, 0)
    );
    const total = round2(subtotal + iva);
    totalPagado += total;
    cerradas++;
    console.log(
      `   ${r.folio}  ${fecha.toISOString().slice(0, 10)}  ${(r.proyecto?.codigo ?? "").padEnd(10)} ` +
        `${cot.supplierNombre.slice(0, 36).padEnd(36)} subtotal ${money(subtotal).padStart(12)}  iva ${money(iva).padStart(10)}  pagar ${money(total).padStart(12)}`
    );
    if (!a.aplicar) continue;

    await prisma.$transaction(async (tx) => {
      // 1) seleccionar la cotización (mismo efecto que POST …/cotizaciones/:cotId/seleccionar)
      await tx.solicitudCompraCotizacion.update({ where: { id: cot.id }, data: { isSelected: true } });
      for (const cp of cot.partidas) {
        const p = r.partidas.find((x) => x.id === cp.solicitudPartidaId)!;
        await tx.solicitudPartida.update({
          where: { id: p.id },
          data: {
            precioUnitario: Number(cp.precioUnitario),
            importe: round2(Number(p.cantidad) * Number(cp.precioUnitario)),
            cotizacionGanadoraId: cot.id,
          },
        });
      }
      await tx.solicitudCompra.update({
        where: { id: r.id },
        data: {
          total: subtotal,
          supplierId: cot.supplierId ?? undefined,
          formaPago: "CONTADO",
          // 2) aprobar (mismo efecto que POST …/aprobar)
          estado: "APROBADA",
          aprobadaPorId: r.creadaPorId,
          aprobadaAt: fecha,
        },
      });
      await generateAdjudicaciones(tx, r.id);

      // 3) pagar cada adjudicación por su total (mismo efecto que POST /adjudicaciones/:id/pagar)
      const adjs = await tx.solicitudAdjudicacion.findMany({
        where: { solicitudId: r.id, estado: "POR_PAGAR" },
        select: { id: true, total: true, supplierId: true, supplierNombre: true },
      });
      for (const adj of adjs) {
        const monto = Number(adj.total);
        const pago = await tx.pagoProveedor.create({
          data: {
            companyId: cid,
            supplierId: adj.supplierId ?? null,
            supplierNombre: adj.supplierNombre,
            fecha,
            monto,
            referencia: REFERENCIA_PAGO,
            notas: `Requisición ${r.folio}`,
          },
        });
        await aplicarPago(tx, { ...pago, monto }, [{ adjudicacionId: adj.id, monto }], fecha);
      }
    });
  }
  console.log(`\n${cerradas} requisiciones ${a.aplicar ? "cerradas" : "por cerrar"}; total a pagar (con IVA) $${money(round2(totalPagado))}`);
  for (const o of omitidas) console.log("   - " + o);
}

async function main() {
  const a = parseArgs();
  const cid = await companyId();
  console.log(`BARTIZ ${BARTIZ_RFC} (${cid})  modo: ${a.aplicar ? "APLICAR" : "dry-run"}  fase: ${a.fase}`);
  const fases = a.fase === "todo" ? ["proveedores", "swap", "cerrar"] : [a.fase];
  for (const f of fases) {
    if (f === "swap") await faseSwap(cid, a);
    else if (f === "proveedores") await faseProveedores(cid, a);
    else if (f === "cerrar") await faseCerrar(cid, a);
    else throw new Error(`Fase desconocida: ${f}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
