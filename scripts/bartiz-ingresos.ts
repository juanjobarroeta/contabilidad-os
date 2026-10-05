/**
 * Ingresos por obra de BARTIZ (CBA170606FQ8): ata cada CFDI de ingreso a su
 * proyecto como Estimación, para que el estado de resultados por obra tenga
 * el lado de los ingresos (hoy sólo existía el de los costos).
 *
 * Fases (`todo` las encadena):
 *   cancelados   — pregunta al SAT (ConsultaCFDI) por cada CFDI de ingreso
 *                  STAMPED de 2026 y marca CANCELLED los que el SAT reporta
 *                  cancelados (p. ej. IOCIFED 8A97CBC4, cancelado 17-sep).
 *   proyectos    — crea las obras de 2025 que siguen cobrando en 2026
 *                  (BOMBEROS-2025 del Municipio de Cuautlancingo, UDLAP-CMAT-2025)
 *                  con su presupuesto de contrato, y liga el cliente de cada
 *                  proyecto existente.
 *   estimaciones — por cada CFDI del mapa UUID→proyecto crea una Estimación
 *                  TIMBRADA con subtotal/IVA/total del CFDI, periodo = mes de
 *                  la factura, ligada por invoiceId. Idempotente: salta los
 *                  CFDIs que ya tienen estimación.
 *
 * NO asienta en el libro (postEstimacionTimbrada): el CFDI ya entra al motor
 * fiscal como ingreso; la estimación aquí es atribución a la obra.
 *
 * Dry-run por defecto; `--aplicar` escribe.
 *   DATABASE_URL=… npx tsx scripts/bartiz-ingresos.ts --fase=todo [--aplicar]
 */

import { PrismaClient } from "@prisma/client";
import {
  construirExpresion,
  consultarEstadoCfdi,
  datosConsultaDesdeXml,
  esCancelado,
} from "@/lib/fiscal/vigencia-cfdi";

const prisma = new PrismaClient();
const BARTIZ_RFC = "CBA170606FQ8";
const DESDE = new Date("2026-01-01T00:00:00Z");

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) =>
  n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Obras de 2025 que cobraron en 2026 (respuesta del usuario, 5-oct-2026).
const PROYECTOS_2025 = [
  {
    codigo: "BOMBEROS-2025",
    nombre: "Estación de Bomberos (obra 2025) — finiquito",
    tipo: "GOBIERNO" as const,
    clienteRfc: "MCP850101944", // MUNICIPIO DE CUAUTLANCINGO PUEBLA
    dependenciaCliente: "Municipio de Cuautlancingo, Puebla",
  },
  {
    codigo: "UDLAP-CMAT-2025",
    nombre: "UDLAP CMAT (obra 2025)",
    tipo: "PRIVADO" as const,
    clienteRfc: "FUA851220CF0", // FUNDACION UNIVERSIDAD DE LAS AMERICAS PUEBLA
    dependenciaCliente: null,
  },
];

// Cliente de cada proyecto existente (por RFC del CFDI que le corresponde).
const CLIENTE_POR_PROYECTO: Record<string, string> = {
  UDLAP001: "FUA851220CF0",
  UDLAP002: "FUA851220CF0",
  UDLAP003: "FUA851220CF0",
  MITLA001: "INI080202BQ8", // INIFED (el CFDI a IOCIFED está cancelado)
};

// CFDI de ingreso (prefijo del UUID) → proyecto. Lo no mapeado se lista como
// pendiente: Altiplano, Parque del Rey, Andaluces, UDLAP 75,218.59.
const ESTIMACION_POR_CFDI: Record<string, { proyecto: string; nota: string }> = {
  D7AC184C: { proyecto: "UDLAP002", nota: "77,229.34 = monto contratado" },
  "6A10730C": { proyecto: "UDLAP003", nota: "327,683.40 = monto contratado" },
  "1044D1B3": { proyecto: "UDLAP001", nota: "309,975.14 = monto contratado" },
  "25B8F124": { proyecto: "MITLA001", nota: "INIFED, vigente; MITLA no tiene anticipo ⇒ estimación 1" },
  "57e10302": { proyecto: "BOMBEROS-2025", nota: "finiquito de bomberos" },
  e1381374: { proyecto: "UDLAP-CMAT-2025", nota: "pago de CMAT" },
};

type Args = { fase: string; aplicar: boolean };
function parseArgs(): Args {
  const get = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  return { fase: get("fase") ?? "todo", aplicar: process.argv.includes("--aplicar") };
}

async function companyId() {
  const c = await prisma.company.findUnique({ where: { rfc: BARTIZ_RFC }, select: { id: true } });
  if (!c) throw new Error(`No existe la empresa ${BARTIZ_RFC}`);
  return c.id;
}

async function ingresos2026(cid: string) {
  return prisma.invoice.findMany({
    where: { companyId: cid, tipo: "INGRESO", status: "STAMPED", fecha: { gte: DESDE } },
    orderBy: { fecha: "asc" },
    select: {
      id: true,
      uuid: true,
      fecha: true,
      contraparteRfc: true,
      contraparteNombre: true,
      subtotal: true,
      totalImpuestos: true,
      total: true,
      metodoPago: true,
      rawXml: true,
      customerId: true,
      estimacion: { select: { id: true, numero: true, proyecto: { select: { codigo: true } } } },
    },
  });
}

// ───────────────────────── fase: cancelados ─────────────────────────
async function faseCancelados(cid: string, a: Args) {
  console.log(`\n=== CANCELADOS: estatus en el SAT de los CFDIs de ingreso STAMPED 2026`);
  const invs = await ingresos2026(cid);
  let cancelados = 0;
  for (const i of invs) {
    if (!i.rawXml || !i.uuid) {
      console.log(`   ${i.uuid?.slice(0, 8) ?? "?"}  sin XML, no se consulta`);
      continue;
    }
    const d = datosConsultaDesdeXml(i.rawXml, i.uuid);
    if (!d) {
      console.log(`   ${i.uuid.slice(0, 8)}  no se pudo armar la expresión`);
      continue;
    }
    const e = await consultarEstadoCfdi(construirExpresion(d));
    const cancelado = e ? esCancelado(e) : false;
    console.log(
      `   ${i.uuid.slice(0, 8)}  ${i.fecha.toISOString().slice(0, 10)}  ${(i.contraparteNombre ?? "").slice(0, 36).padEnd(36)} ` +
        `$${money(Number(i.total)).padStart(14)}  SAT: ${e?.estado ?? "?"}${cancelado ? "  ⇒ CANCELLED" : ""}`
    );
    if (cancelado) {
      cancelados++;
      if (a.aplicar) await prisma.invoice.update({ where: { id: i.id }, data: { status: "CANCELLED" } });
    }
  }
  console.log(`${cancelados} CFDI ${a.aplicar ? "marcados" : "por marcar"} CANCELLED`);
}

// ───────────────────────── fase: proyectos ─────────────────────────
async function faseProyectos(cid: string, a: Args) {
  console.log(`\n=== PROYECTOS`);
  const customers = await prisma.customer.findMany({
    where: { companyId: cid, rfc: { in: [...new Set([...PROYECTOS_2025.map((p) => p.clienteRfc), ...Object.values(CLIENTE_POR_PROYECTO)])] } },
    select: { id: true, rfc: true, razonSocial: true },
  });
  const customerPorRfc = new Map(customers.map((c) => [c.rfc, c]));
  const invs = await ingresos2026(cid);

  for (const p of PROYECTOS_2025) {
    const cliente = customerPorRfc.get(p.clienteRfc);
    if (!cliente) throw new Error(`No existe Customer con RFC ${p.clienteRfc}`);
    const existente = await prisma.proyecto.findUnique({ where: { companyId_codigo: { companyId: cid, codigo: p.codigo } }, select: { id: true } });
    // El contrato se desconoce: el presupuesto de contrato toma el subtotal de lo cobrado en 2026.
    const cobrado = round2(
      Object.entries(ESTIMACION_POR_CFDI)
        .filter(([, m]) => m.proyecto === p.codigo)
        .map(([pref]) => invs.find((i) => i.uuid?.toUpperCase().startsWith(pref.toUpperCase())))
        .reduce((s, i) => s + Number(i?.subtotal ?? 0), 0)
    );
    console.log(`   ${existente ? "=" : "+"} ${p.codigo}  «${p.nombre}»  cliente ${cliente.razonSocial}  TERMINADO  presupuesto contrato $${money(cobrado)}`);
    if (!a.aplicar || existente) continue;
    await prisma.$transaction(async (tx) => {
      const proy = await tx.proyecto.create({
        data: {
          companyId: cid,
          customerId: cliente.id,
          codigo: p.codigo,
          nombre: p.nombre,
          tipo: p.tipo,
          estado: "TERMINADO",
          dependenciaCliente: p.dependenciaCliente,
          montoContratado: cobrado,
          aplicaIva: true,
          utilidadPorc: null,
        },
      });
      await tx.presupuesto.create({
        data: {
          companyId: cid,
          proyectoId: proy.id,
          nombre: "Contrato (histórico, obra 2025)",
          version: 1,
          estado: "APROBADO",
          montoTotal: cobrado,
          tipoPresupuesto: "CONTRATO",
        },
      });
    });
  }

  for (const [codigo, rfc] of Object.entries(CLIENTE_POR_PROYECTO)) {
    const cliente = customerPorRfc.get(rfc);
    const proy = await prisma.proyecto.findUnique({ where: { companyId_codigo: { companyId: cid, codigo } }, select: { id: true, customerId: true } });
    if (!proy || !cliente) {
      console.log(`   ! ${codigo}: proyecto o cliente ${rfc} no existe`);
      continue;
    }
    if (proy.customerId === cliente.id) continue;
    console.log(`   ${codigo}: cliente → ${cliente.razonSocial}`);
    if (a.aplicar) await prisma.proyecto.update({ where: { id: proy.id }, data: { customerId: cliente.id } });
  }
}

// ───────────────────────── fase: estimaciones ─────────────────────────
async function faseEstimaciones(cid: string, a: Args) {
  console.log(`\n=== ESTIMACIONES desde CFDIs de ingreso`);
  const invs = await ingresos2026(cid);
  let creadas = 0;
  let ingresoAtribuido = 0;
  const pendientes: string[] = [];
  for (const i of invs) {
    const pref = Object.keys(ESTIMACION_POR_CFDI).find((k) => i.uuid?.toUpperCase().startsWith(k.toUpperCase()));
    const linea = `${i.uuid?.slice(0, 8)}  ${i.fecha.toISOString().slice(0, 10)}  ${(i.contraparteNombre ?? "").slice(0, 34).padEnd(34)} $${money(Number(i.total)).padStart(14)}`;
    if (i.estimacion) {
      console.log(`   ${linea}  ya es EST. ${i.estimacion.numero} de ${i.estimacion.proyecto.codigo}`);
      continue;
    }
    if (!pref) {
      pendientes.push(linea);
      continue;
    }
    const map = ESTIMACION_POR_CFDI[pref];
    const proy = await prisma.proyecto.findUnique({
      where: { companyId_codigo: { companyId: cid, codigo: map.proyecto } },
      select: {
        id: true,
        codigo: true,
        presupuestos: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, estado: true } },
        estimaciones: { orderBy: { numero: "desc" }, take: 1, select: { numero: true } },
      },
    });
    if (!proy) {
      console.log(`   ${linea}  ! proyecto ${map.proyecto} no existe (corre la fase proyectos)`);
      continue;
    }
    const presupuesto = proy.presupuestos[0];
    if (!presupuesto) {
      console.log(`   ${linea}  ! ${map.proyecto} sin presupuesto`);
      continue;
    }
    const numero = (proy.estimaciones[0]?.numero ?? 0) + 1;
    const subtotal = round2(Number(i.subtotal));
    const iva = round2(Number(i.totalImpuestos ?? 0));
    const total = round2(Number(i.total));
    const periodoInicio = new Date(Date.UTC(i.fecha.getUTCFullYear(), i.fecha.getUTCMonth(), 1));
    const periodoFin = new Date(Date.UTC(i.fecha.getUTCFullYear(), i.fecha.getUTCMonth() + 1, 0));
    creadas++;
    ingresoAtribuido += subtotal;
    console.log(`   ${linea}  → EST. ${numero} de ${proy.codigo} (${map.nota}); subtotal ${money(subtotal)} + IVA ${money(iva)}${presupuesto.estado === "BORRADOR" ? "  [presupuesto BORRADOR]" : ""}`);
    if (!a.aplicar) continue;
    await prisma.estimacion.create({
      data: {
        companyId: cid,
        proyectoId: proy.id,
        presupuestoId: presupuesto.id,
        numero,
        periodoInicio,
        periodoFin,
        fechaCorte: i.fecha,
        estado: "TIMBRADA",
        subtotal,
        iva,
        total,
        importeAcumulado: subtotal,
        pctPeriodo: 0,
        pctAcumulado: 0,
        invoiceId: i.id,
      },
    });
  }
  console.log(`\n${creadas} estimaciones ${a.aplicar ? "creadas" : "por crear"}; ingreso atribuido (sin IVA) $${money(round2(ingresoAtribuido))}`);
  console.log(`CFDIs de ingreso SIN proyecto (${pendientes.length}):`);
  for (const p of pendientes) console.log("   " + p);
}

async function main() {
  const a = parseArgs();
  const cid = await companyId();
  console.log(`BARTIZ ${BARTIZ_RFC} (${cid})  modo: ${a.aplicar ? "APLICAR" : "dry-run"}  fase: ${a.fase}`);
  const fases = a.fase === "todo" ? ["cancelados", "proyectos", "estimaciones"] : [a.fase];
  for (const f of fases) {
    if (f === "cancelados") await faseCancelados(cid, a);
    else if (f === "proyectos") await faseProyectos(cid, a);
    else if (f === "estimaciones") await faseEstimaciones(cid, a);
    else throw new Error(`Fase desconocida: ${f}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
