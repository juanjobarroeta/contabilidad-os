/**
 * Reparación de las requisiciones históricas de BARTIZ (CBA170606FQ8).
 *
 * Contexto: el formulario de requisiciones de bartiz tenía las columnas
 * «Cantidad» y «Unidad» desalineadas (arreglado en bartiz PR #69), así que
 * el residente capturó el PRECIO en cantidad y la CANTIDAD en el precio de
 * la cotización. Cada requisición trae UNA sola cotización (no hubo
 * concurso) y ya está pagada en la realidad, pero quedó PENDIENTE sin
 * adjudicar, así que no cuenta como costo del proyecto.
 *
 * Verificado contra los CFDIs recibidos: la cifra capturada es el TOTAL
 * pagado (con IVA cuando el proveedor factura), aunque la nota diga «el
 * precio es sin IVA». Por eso el pagable siempre es lo capturado; para
 * proveedores formales se desglosa ÷1.16 en subtotal + IVA.
 *
 * Fases (`todo` las encadena en este orden):
 *   proveedores — unifica variantes de nombre, da de alta Supplier con el
 *                 RFC del CFDI que empata con la requisición, y liga
 *                 supplierId por nombre/RFC. Lista los nombres sin RFC.
 *   swap        — intercambia partida.cantidad ↔ cotización.precioUnitario
 *                 (salvo líneas bien capturadas y litros de bomba), separa
 *                 «8 PZA», recalcula importes y fija ivaTasa:
 *                   · proveedor formal (Supplier con RFC, CFDI empatado, o
 *                     S.A./S. de R.L.) ⇒ precio ÷ 1.16 y tasa 16 %:
 *                     pagable = capturado.
 *                   · informal (personas, peajes, gasolina, taxis…) ⇒ sin
 *                     IVA: pagable = capturado.
 *   cerrar      — selecciona la cotización única, APRUEBA (adjudicaciones
 *                 con desglose de IVA) y registra el PAGO por el total con
 *                 fecha de captura ⇒ PAGADA; el proyecto ya la ve en
 *                 comprometido y pagadoReal.
 *   cfdis       — vincula los CFDIs de egreso (STAMPED) con la requisición
 *                 cuyo total coincide (uno a uno, o varios del mismo RFC y
 *                 día que suman) ⇒ aparece en «facturado» del proyecto.
 *
 * Seguridad: dry-run por defecto. `--aplicar` escribe. `--hasta=<ISO>`
 * limita a requisiciones creadas antes de esa fecha (default: ahora). El
 * libro local `.bartiz-reparacion.json` evita hacer el swap dos veces.
 *
 * Correr:
 *   DATABASE_URL=… npx tsx scripts/bartiz-reparar-requisiciones.ts --fase=todo [--aplicar] [--hasta=2026-10-03T00:00:00Z]
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
const CFDI_DESDE = new Date("2026-07-01T00:00:00Z");
// Muchas idas y vueltas por requisición sobre el proxy público de Railway:
// el timeout default de 5 s de la transacción interactiva no alcanza (P2028).
const TX_OPTS = { timeout: 120_000, maxWait: 20_000 };
const EPS = 0.05; // un CFDI contra una requisición
const EPS_GRUPO = 0.5; // varios CFDIs del mismo RFC y día: redondeos de centavos por línea

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

// Proveedores formales (facturan) que todavía no tienen Supplier/RFC.
const FORMAL_SIN_RFC = /S\.?\s?A\.?\s?(DE\s?C\.?V\.?)?$|S\.?\s?DE\s?R\.?L\.?|^LAMONT$|^TEPSA\b/i;

// Combustible despachado: la bomba da litros con 3 decimales (21.286 L) y el
// precio por litro es mayor que los litros ⇒ ya está bien capturado.
function esCombustibleBien(unidad: string | null, cantidad: number, precio: number) {
  if (!unidad || !/^(L|LT|LTS|LITRO|LITROS)$/i.test(unidad.trim())) return false;
  const decimales = (String(cantidad).split(".")[1] ?? "").length;
  return decimales >= 3 && precio > cantidad;
}

function canonico(nombre: string) {
  const n = nombre.trim();
  return NOMBRES_CANONICOS[n.toUpperCase()] ?? n;
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

async function suppliersDe(cid: string) {
  const suppliers = await prisma.supplier.findMany({
    where: { companyId: cid },
    select: { id: true, rfc: true, razonSocial: true },
  });
  return {
    porNombre: new Map(suppliers.map((s) => [s.razonSocial.trim().toUpperCase(), s])),
    porRfc: new Map(suppliers.map((s) => [s.rfc, s])),
  };
}

// Requisiciones capturadas desde bartiz (REQ-…), creadas antes del corte.
async function requisiciones(cid: string, hasta: Date, estado?: "PENDIENTE") {
  return prisma.solicitudCompra.findMany({
    where: {
      companyId: cid,
      ...(estado && { estado }),
      folio: { startsWith: "REQ-" },
      createdAt: { lte: hasta },
    },
    orderBy: { createdAt: "asc" },
    include: {
      proyecto: { select: { codigo: true } },
      partidas: { include: { cotizaciones: true } },
      cotizaciones: { include: { partidas: true, supplier: { select: { rfc: true } } } },
    },
  });
}

type Req = Awaited<ReturnType<typeof requisiciones>>[number];

function unicaCotizacion(r: Req) {
  if (r.cotizaciones.length !== 1) return null;
  const cot = r.cotizaciones[0];
  const cubiertas = new Set(cot.partidas.map((p) => p.solicitudPartidaId));
  if (!r.partidas.every((p) => cubiertas.has(p.id))) return null;
  return cot;
}

// Pagable de la única cotización: Σ importe + IVA de cada línea (ivaTasa de la partida).
function pagableDe(r: Req, cot: Req["cotizaciones"][number]) {
  let t = 0;
  for (const cp of cot.partidas) {
    const p = r.partidas.find((x) => x.id === cp.solicitudPartidaId);
    const tasa = p?.ivaTasa == null ? 0 : Number(p.ivaTasa);
    t += Number(cp.importe) + round2(Number(cp.importe) * tasa);
  }
  return round2(t);
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

// ───────────────────── empate CFDI ↔ requisición ─────────────────────
//
// El total capturado en la requisición es el total del CFDI. Empata un CFDI
// con la requisición de igual total (si la cotización ya tiene RFC, debe
// coincidir), o varios CFDIs del mismo RFC y fecha que suman el total.
type Cfdi = { id: string; uuid: string | null; rfc: string; nombre: string; total: number; fecha: Date };
type Empate = { req: Req; cotId: string; invoices: Cfdi[]; rfc: string; nombre: string };

async function emparejarCfdis(cid: string, hasta: Date): Promise<{ empates: Empate[]; ambiguas: string[] }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: cid,
      tipo: "EGRESO",
      status: "STAMPED",
      fecha: { gte: CFDI_DESDE },
      construccionVinculo: null,
    },
    select: { id: true, uuid: true, contraparteRfc: true, contraparteNombre: true, total: true, fecha: true },
  });
  const libres: Cfdi[] = invoices
    .filter((i) => !!i.contraparteRfc)
    .map((i) => ({
      id: i.id,
      uuid: i.uuid,
      rfc: i.contraparteRfc!,
      nombre: i.contraparteNombre ?? i.contraparteRfc!,
      total: Number(i.total),
      fecha: i.fecha,
    }));
  const reqs = await requisiciones(cid, hasta);
  const usados = new Set<string>();
  const empates: Empate[] = [];
  const ambiguas: string[] = [];

  for (const r of reqs) {
    const cot = unicaCotizacion(r);
    if (!cot) continue;
    // El CFDI trae el total con IVA; tras el swap la cotización guarda el
    // subtotal, así que se compara contra el pagable (importe + IVA por línea).
    const total = pagableDe(r, cot);
    const rfcCot = cot.supplier?.rfc ?? null;
    const pool = libres.filter((i) => !usados.has(i.id) && (!rfcCot || i.rfc === rfcCot));

    // 1) un CFDI con el mismo total
    const exactos = pool.filter((i) => Math.abs(i.total - total) <= EPS);
    if (exactos.length > 1) {
      ambiguas.push(`${r.folio}: ${exactos.length} CFDIs con total ${money(total)} (${[...new Set(exactos.map((i) => i.rfc))].join(", ")})`);
      continue;
    }
    let grupo: Cfdi[] | null = exactos.length === 1 ? exactos : null;

    // 2) varios del mismo RFC y día que suman el total
    if (!grupo) {
      const porRfcDia = new Map<string, Cfdi[]>();
      for (const i of pool) {
        const k = `${i.rfc}|${i.fecha.toISOString().slice(0, 10)}`;
        porRfcDia.set(k, [...(porRfcDia.get(k) ?? []), i]);
      }
      const grupos = [...porRfcDia.values()].filter(
        (g) => g.length > 1 && Math.abs(g.reduce((s, i) => s + i.total, 0) - total) <= EPS_GRUPO
      );
      if (grupos.length === 1) grupo = grupos[0];
      else if (grupos.length > 1) {
        ambiguas.push(`${r.folio}: ${grupos.length} grupos de CFDIs suman ${money(total)}`);
        continue;
      }
    }
    if (!grupo) continue;
    for (const i of grupo) usados.add(i.id);
    empates.push({ req: r, cotId: cot.id, invoices: grupo, rfc: grupo[0].rfc, nombre: grupo[0].nombre });
  }
  return { empates, ambiguas };
}

// ───────────────────────── fase: proveedores ─────────────────────────
async function faseProveedores(cid: string, a: Args) {
  console.log(`\n=== PROVEEDORES`);
  const { porNombre, porRfc } = await suppliersDe(cid);

  // a) Supplier nuevos con el RFC del CFDI que empata con la requisición.
  const { empates } = await emparejarCfdis(cid, a.hasta);
  const nuevos = new Map<string, { rfc: string; razonSocial: string; cotIds: string[]; nombreCapturado: string }>();
  const rfcPorCot = new Map<string, string>();
  for (const e of empates) {
    rfcPorCot.set(e.cotId, e.rfc);
    const cot = e.req.cotizaciones[0];
    if (cot.supplierId || porRfc.has(e.rfc)) continue;
    const n = nuevos.get(e.rfc) ?? { rfc: e.rfc, razonSocial: e.nombre, cotIds: [], nombreCapturado: canonico(cot.supplierNombre) };
    n.cotIds.push(cot.id);
    nuevos.set(e.rfc, n);
  }
  for (const n of nuevos.values()) {
    console.log(`   + Supplier ${n.rfc}  «${n.razonSocial}»  (capturado como «${n.nombreCapturado}», ${n.cotIds.length} cot.)`);
    if (a.aplicar) {
      const s = await prisma.supplier.create({
        data: { companyId: cid, rfc: n.rfc, razonSocial: n.razonSocial },
        select: { id: true, rfc: true, razonSocial: true },
      });
      porRfc.set(s.rfc, s);
      porNombre.set(s.razonSocial.toUpperCase(), s);
    }
  }

  // b) nombres canónicos + liga por nombre o por RFC del CFDI empatado.
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
    const rfcCfdi = rfcPorCot.get(c.id);
    const sup = porNombre.get(canon.toUpperCase()) ?? (rfcCfdi ? porRfc.get(rfcCfdi) : undefined);
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
    if (!sup && !c.supplierId && !rfcCfdi) {
      const e = sinSupplier.get(canon) ?? { n: 0, total: 0 };
      e.n++;
      e.total += Number(c.total);
      sinSupplier.set(canon, e);
    }
    if (a.aplicar && Object.keys(data).length > 0) {
      await prisma.solicitudCompraCotizacion.update({ where: { id: c.id }, data });
    }
  }
  console.log(`\n${nuevos.size} Supplier nuevos desde CFDI, ${renombradas} nombres unificados, ${ligadas} cotizaciones ligadas a un Supplier.`);
  console.log(`\nNombres SIN Supplier (sin RFC conocido — ${sinSupplier.size}):`);
  for (const [nombre, e] of [...sinSupplier].sort((x, y) => y[1].total - x[1].total)) {
    console.log(`   ${nombre.padEnd(50)} ${String(e.n).padStart(3)} cot.  $${money(e.total)}`);
  }
}

// ───────────────────────── fase: swap ─────────────────────────
async function faseSwap(cid: string, a: Args) {
  const libro = leerLibro();
  const { porNombre } = await suppliersDe(cid);
  const { empates } = await emparejarCfdis(cid, a.hasta);
  const conCfdi = new Set(empates.map((e) => e.cotId));
  const reqs = await requisiciones(cid, a.hasta, "PENDIENTE");
  console.log(`\n=== SWAP cantidad ↔ precio + IVA por línea (${reqs.length} requisiciones PENDIENTES REQ-*, hasta ${a.hasta.toISOString()})`);

  const omitidas: string[] = [];
  let lineas = 0;
  const resumen = { formal: { reqs: 0, pagable: 0, iva: 0 }, informal: { reqs: 0, pagable: 0 } };
  const formales = new Map<string, number>();
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
    const nombre = canonico(cot.supplierNombre);
    const formal =
      !!cot.supplierId || conCfdi.has(cot.id) || porNombre.has(nombre.toUpperCase()) || FORMAL_SIN_RFC.test(nombre);
    const ivaTasa: number | null = formal ? 0.16 : null;
    console.log(
      `\n${r.folio}  [${r.proyecto?.codigo ?? "sin proyecto"}]  ${cot.supplierNombre}  ${r.notas ? `«${r.notas}»` : ""}  → ` +
        (formal ? "formal: capturado ÷ 1.16 + IVA 16 %" : "informal: sin IVA")
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
      if (formal) precioNuevo = round4(precioNuevo / 1.16);
      const importe = round2(cantidadNueva * precioNuevo);
      const unidadNueva = separarUnidad(p.unidad, cantidadNueva);
      totalCot += importe;
      lineas++;

      console.log(
        `   ${p.descripcion.slice(0, 44).padEnd(44)} ` +
          `antes ${capQty} ${p.unidad ?? ""} @ ${money(capPrecio)}  →  ` +
          `${cantidadNueva} ${unidadNueva ?? ""} @ ${money(precioNuevo)} = ${money(importe)}` +
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
    const iva = formal ? round2(totalCot * 0.16) : 0;
    const pagable = round2(totalCot + iva);
    console.log(`   cotización ${money(Number(cot.total))} → subtotal ${money(totalCot)} + IVA ${money(iva)} = pagable ${money(pagable)}`);
    if (formal) {
      resumen.formal.reqs++;
      resumen.formal.pagable += pagable;
      resumen.formal.iva += iva;
      formales.set(nombre, (formales.get(nombre) ?? 0) + pagable);
    } else {
      resumen.informal.reqs++;
      resumen.informal.pagable += totalCot;
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
    `\nFormales: ${resumen.formal.reqs} req., pagable $${money(round2(resumen.formal.pagable))} (IVA incluido $${money(round2(resumen.formal.iva))}). ` +
      `Informales: ${resumen.informal.reqs} req., pagable $${money(round2(resumen.informal.pagable))} sin IVA.`
  );
  console.log("Proveedores tratados como formales (÷1.16):");
  for (const [n, t] of [...formales].sort((x, y) => y[1] - x[1])) {
    console.log(`   ${n.padEnd(50)} $${money(round2(t))}`);
  }
}

// ───────────────────────── fase: cerrar ─────────────────────────
async function faseCerrar(cid: string, a: Args) {
  const reqs = await requisiciones(cid, a.hasta, "PENDIENTE");
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
    }, TX_OPTS);
  }
  console.log(`\n${cerradas} requisiciones ${a.aplicar ? "cerradas" : "por cerrar"}; total pagado (con IVA) $${money(round2(totalPagado))}`);
  for (const o of omitidas) console.log("   - " + o);
}

// ───────────────────────── fase: cfdis ─────────────────────────
async function faseCfdis(cid: string, a: Args) {
  const { empates, ambiguas } = await emparejarCfdis(cid, a.hasta);
  console.log(`\n=== CFDIs ↔ requisiciones (${empates.length} empates)`);
  let total = 0;
  for (const e of empates) {
    const label = `${e.req.folio}${e.req.proyecto?.codigo ? ` · ${e.req.proyecto.codigo}` : ""}`;
    const suma = e.invoices.reduce((s, i) => s + i.total, 0);
    total += suma;
    console.log(
      `   ${label.padEnd(30)} ${e.nombre.slice(0, 34).padEnd(34)} ${e.rfc.padEnd(13)} ` +
        `${e.invoices.length} CFDI  $${money(suma).padStart(12)}  (capturado «${e.req.cotizaciones[0].supplierNombre}»)`
    );
    if (!a.aplicar) continue;
    for (const i of e.invoices) {
      const data = { estado: "VINCULADA", targetTipo: "SOLICITUD", targetId: e.req.id, targetLabel: label };
      await prisma.construccionCfdiVinculo.upsert({
        where: { invoiceId: i.id },
        create: { invoiceId: i.id, companyId: cid, ...data },
        update: data,
      });
    }
  }
  console.log(`\n$${money(round2(total))} facturado ${a.aplicar ? "vinculado" : "por vincular"}; ambiguas: ${ambiguas.length}`);
  for (const x of ambiguas) console.log("   - " + x);
}

async function main() {
  const a = parseArgs();
  const cid = await companyId();
  console.log(`BARTIZ ${BARTIZ_RFC} (${cid})  modo: ${a.aplicar ? "APLICAR" : "dry-run"}  fase: ${a.fase}`);
  const fases = a.fase === "todo" ? ["proveedores", "swap", "cerrar", "cfdis"] : [a.fase];
  for (const f of fases) {
    if (f === "proveedores") await faseProveedores(cid, a);
    else if (f === "swap") await faseSwap(cid, a);
    else if (f === "cerrar") await faseCerrar(cid, a);
    else if (f === "cfdis") await faseCfdis(cid, a);
    else throw new Error(`Fase desconocida: ${f}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
