/**
 * hospital-bootstrap.ts — modela un hospital REAL desde sus datos fiscales.
 *
 * El seed (seed-hospital-demo.ts) arma un mundo ficticio; esto es lo contrario:
 * toma una empresa que YA tiene su archivo de CFDIs en el hub y deriva la
 * estructura del módulo HOSPITAL con lo que las facturas ya dicen:
 *
 *   · Pagadores  — aseguradoras (por nombre) y empresas con facturación
 *                  recurrente entre los receptores de INGRESO; más «Particular».
 *   · Médicos    — personas físicas que facturan al hospital con retención de
 *                  ISR (honorarios) o con conceptos médicos.
 *   · Tarifario  — conceptos de INGRESO recurrentes (≥ 3 facturas) con su
 *                  precio típico y su categoría inferida.
 *   · Pacientes  — nombres que vienen en los conceptos («paciente X», «px X»),
 *                  ligados al receptor fiscal de esa factura.
 *   · Farmacia   — catálogo y kardex desde las compras/ventas (insumos-cfdi).
 *
 * Nada de esto es la verdad clínica: es el punto de partida para que el
 * hospital corrija en pantalla en vez de capturar de cero. Idempotente: se
 * puede correr las veces que haga falta; no toca lo que ya existe.
 *
 * Uso:
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/hospital-bootstrap.ts \
 *     --rfc CPM2307076Z9 [--nombre "Haltus Hope"] [--admin correo] [--dry-run] [--sin-farmacia] [--solo-farmacia]
 */
import { PrismaClient, type HospCargoCategoria, type HospPagadorTipo } from "@prisma/client";
import { clasificarInsumo, derivarInsumosBackfill, normalizarDescripcion } from "../src/lib/hospital/insumos-cfdi";

const prisma = new PrismaClient();

function arg(nombre: string): string | null {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (nombre: string) => process.argv.includes(nombre);

// El proxy público de Postgres corta conexiones largas (P1017). Cada fase es
// idempotente, así que ante un corte se reconecta y la fase se repite entera.
const CORTES = new Set(["P1017", "P1001", "P2024"]);
async function conReintento<T>(nombre: string, fn: () => Promise<T>, intentos = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !CORTES.has(code) || i >= intentos) throw e;
      console.log(`\n  · conexión cortada en ${nombre} (${code}); reconectando (${i}/${intentos})…`);
      await prisma.$disconnect().catch(() => {});
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
const r2 = (n: number) => Math.round(n * 100) / 100;

const MINUSCULAS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y", "E", "DA", "DI", "VON", "VAN"]);
const SIGLAS = new Set(["SA", "CV", "SAPI", "SC", "AC", "SRL", "RL", "SAS", "SCP", "IAP", "SNC", "SPR", "SOFOM", "ENR", "ER", "II", "III", "IV"]);
function nombrePropio(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const u = w.toUpperCase();
      if (i > 0 && MINUSCULAS.has(u)) return u.toLowerCase();
      if (SIGLAS.has(u.replace(/\./g, ""))) return u;
      return u.charAt(0) + u.slice(1).toLowerCase();
    })
    .join(" ");
}

const ASEGURADORA_RE =
  /SEGUROS|ASEGURADORA|\bGNP\b|\bAXA\b|METLIFE|MAPFRE|ALLIANZ|BUPA|PLAN SEGURO|INBURSA|CHUBB|ZURICH|\bSURA\b|ATLAS|\bHDI\b|QUALITAS|MONTERREY NEW YORK|GENERAL DE SALUD|MEDICA INTEGRAL|PREVEM|BANORTE|THONA|PAN-AMERICAN|PANAMERICAN|ARGOS/i;
const CONCEPTO_MEDICO_RE = /HONORARIO|MEDIC|CIRUG|ANESTES|CONSULTA|QUIRURG|PROCEDIMIENTO|INTERCONSULTA|VALORACION/i;

function categoriaDe(desc: string): HospCargoCategoria {
  const d = normalizarDescripcion(desc);
  if (/HONORARIO/.test(d)) return "HONORARIO";
  if (/FARMACIA|MEDICAMENTO/.test(d)) return "FARMACIA";
  if (/CENTRAL DE EQUIPOS|ESTERILIZACION|MATERIAL|INSUMO/.test(d)) return "MATERIAL";
  if (/QUIROFANO|SALA DE OPERACION/.test(d)) return "QUIROFANO";
  if (/URGENCIA/.test(d)) return "URGENCIAS";
  if (/HOSPITALIZACION|HABITACION|RECUPERACION|ESTANCIA|TERAPIA INTENSIVA|CUIDADOS INTENSIVOS|CUNERO/.test(d)) return "HABITACION";
  if (/LABORATORIO|PATOLOGIA|TOMOGRAFIA|RAYOS X|ULTRASONIDO|RESONANCIA|ESTUDIO|IMAGEN|ELECTROCARDIOGRAMA|MASTOGRAFIA|DENSITOMETRIA/.test(d)) return "ESTUDIO";
  if (/ENDOSCOPIA|COLONOSCOPIA|PAQUETE|CIRUGIA|PROCEDIMIENTO|BIOPSIA|QUIMIOTERAPIA|ONCOLOG|INFUSION|SESION|INHALOTERAPIA|TERAPIA|BANCO DE SANGRE|TRANSFUSION/.test(d)) return "PROCEDIMIENTO";
  if (/EQUIPO|RENTA/.test(d)) return "EQUIPO";
  return "OTRO";
}

function claveDe(desc: string, usadas: Set<string>): string {
  const base = normalizarDescripcion(desc).replace(/\s+/g, "-").slice(0, 24).replace(/-+$/, "") || "SERV";
  let clave = base;
  let n = 2;
  while (usadas.has(clave)) clave = `${base.slice(0, 20)}-${n++}`;
  usadas.add(clave);
  return clave;
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// «Servicio de hospitalización PX Viridiana Marquez Palacios» → «Viridiana Marquez Palacios»
const PACIENTE_RE = /(?:\bPACIENTE|\bPX)\b\.?\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ]+(?:\s+(?:DE|DEL|LA|LAS|LOS|Y|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ]+)){1,6})/;
function nombreDePaciente(desc: string): string | null {
  const m = desc
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .match(PACIENTE_RE);
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter((t) => !/^(SERVICIO|SERVICIOS|HOSPITALIZACION|CON|POR|EL|EN|UN|UNA)$/.test(t));
  while (tokens.length && MINUSCULAS.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length < 2 || tokens.length > 7) return null;
  return tokens.join(" ");
}
function partirNombre(completo: string): { nombre: string; apellidoPaterno: string; apellidoMaterno: string | null } {
  const t = completo.split(/\s+/);
  // Los apellidos van al final: «DE LA TORRE» se pega a su apellido.
  const apellidos: string[] = [];
  while (t.length > 1 && apellidos.length < 2) {
    let ap = t.pop()!;
    while (t.length > 1 && MINUSCULAS.has(t[t.length - 1])) ap = `${t.pop()} ${ap}`;
    apellidos.unshift(ap);
  }
  return {
    nombre: nombrePropio(t.join(" ")),
    apellidoPaterno: nombrePropio(apellidos[0] ?? ""),
    apellidoMaterno: apellidos[1] ? nombrePropio(apellidos[1]) : null,
  };
}

async function main() {
  const rfc = arg("--rfc");
  if (!rfc) throw new Error("Uso: --rfc <RFC> [--nombre ...] [--admin correo] [--dry-run] [--sin-farmacia] [--solo-farmacia]");
  const soloFarmacia = flag("--solo-farmacia");
  const dry = flag("--dry-run");
  const company = await prisma.company.findUnique({ where: { rfc }, select: { id: true, razonSocial: true, nombreComercial: true } });
  if (!company) throw new Error(`No existe empresa con RFC ${rfc}`);
  const cid = company.id;
  console.log(`\n${dry ? "[DRY-RUN] " : ""}${company.razonSocial} (${rfc}) · ${cid}`);

  // ── 1. Módulo, configuración y (opcional) un administrador ────────────────
  if (!dry && !soloFarmacia) await conReintento("módulo", async () => {
    await prisma.companyModule.upsert({
      where: { companyId_modulo: { companyId: cid, modulo: "HOSPITAL" } },
      create: { companyId: cid, modulo: "HOSPITAL" },
      update: { habilitado: true },
    });
    const nombreHospital = arg("--nombre") ?? company.nombreComercial ?? null;
    await prisma.hospConfig.upsert({
      where: { companyId: cid },
      create: { companyId: cid, nombreHospital },
      update: nombreHospital ? { nombreHospital } : {},
    });
    const admin = arg("--admin");
    if (admin) {
      const u = await prisma.user.findUnique({ where: { email: admin.toLowerCase() }, select: { id: true } });
      if (!u) console.log(`  ! no existe el usuario ${admin}; no se agregó como administrador`);
      else {
        const m = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId: u.id, companyId: cid } } });
        if (!m) {
          await prisma.companyMember.create({ data: { userId: u.id, companyId: cid, role: "ADMIN" } });
          console.log(`  + ${admin} como ADMIN`);
        }
      }
    }
    console.log("  ✓ módulo HOSPITAL habilitado");
  });


  // ── 3. Pagadores: aseguradoras y empresas entre los receptores ────────────
  if (!soloFarmacia) await conReintento("pagadores", async () => {
  const receptores = await prisma.$queryRaw<Array<{ id: string; rfc: string; razon: string; facturas: number; total: number; ultima: Date }>>`
    SELECT c.id, c.rfc, c."razonSocial" AS razon, COUNT(*)::int AS facturas, SUM(i.total)::float8 AS total, MAX(i.fecha) AS ultima
    FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'INGRESO' AND i.status <> 'CANCELLED' AND c.rfc <> ${rfc}
    GROUP BY c.id, c.rfc, c."razonSocial"`;
  const pagadores: Array<{ customerId: string | null; nombre: string; tipo: HospPagadorTipo; plazoDias: number; notas: string }> = [];
  for (const r of receptores) {
    const esAseg = ASEGURADORA_RE.test(r.razon);
    const esMoral = r.rfc.length === 12;
    if (esAseg) pagadores.push({ customerId: r.id, nombre: nombrePropio(r.razon), tipo: "ASEGURADORA", plazoDias: 45, notas: `Derivado de los CFDIs: ${r.facturas} facturas · $${r2(r.total).toLocaleString("es-MX")}` });
    else if (esMoral && r.facturas >= 3 && !/XAXX010101000|XEXX010101000/.test(r.rfc))
      pagadores.push({ customerId: r.id, nombre: nombrePropio(r.razon), tipo: "EMPRESA", plazoDias: 30, notas: `Derivado de los CFDIs: ${r.facturas} facturas · $${r2(r.total).toLocaleString("es-MX")} — confirmar si es convenio o sólo receptor fiscal` });
  }
  pagadores.push({ customerId: null, nombre: "Particular", tipo: "PARTICULAR", plazoDias: 0, notas: "Sin convenio: paga el paciente, de contado" });
  let pagadoresNuevos = 0;
  for (const p of pagadores) {
    const existe = p.customerId
      ? await prisma.hospPagador.findFirst({ where: { companyId: cid, customerId: p.customerId }, select: { id: true } })
      : await prisma.hospPagador.findFirst({ where: { companyId: cid, tipo: "PARTICULAR" }, select: { id: true } });
    if (existe) continue;
    pagadoresNuevos++;
    if (dry) { console.log(`  pagador ${p.tipo}: ${p.nombre}`); continue; }
    await prisma.hospPagador.create({ data: { companyId: cid, customerId: p.customerId, nombre: p.nombre, tipo: p.tipo, plazoDias: p.plazoDias, notas: p.notas } });
  }
  console.log(`  ✓ pagadores: ${pagadores.length} candidatos · ${pagadoresNuevos} nuevos`);
  });

  // ── 4. Médicos: personas físicas que facturan honorarios ──────────────────
  if (!soloFarmacia) await conReintento("médicos", async () => {
  const pf = await prisma.$queryRaw<Array<{ rfc: string; razon: string; facturas: number; total: number; isr: number; medico: boolean }>>`
    SELECT c.rfc, c."razonSocial" AS razon, COUNT(DISTINCT i.id)::int AS facturas, SUM(i.total)::float8 AS total,
           COALESCE((SELECT SUM(t.importe) FROM "InvoiceTax" t WHERE t."invoiceId" = ANY(ARRAY_AGG(i.id)) AND t.tipo = 'ISR' AND t.retencion), 0)::float8 AS isr,
           BOOL_OR(it.descripcion ~* 'HONORARIO|MEDIC|CIRUG|ANESTES|CONSULTA|QUIRURG|PROCEDIMIENTO|INTERCONSULTA|VALORACION') AS medico
    FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
    LEFT JOIN "InvoiceItem" it ON it."invoiceId" = i.id
    WHERE i."companyId" = ${cid} AND i.tipo = 'EGRESO' AND i.status <> 'CANCELLED' AND LENGTH(c.rfc) = 13
    GROUP BY c.rfc, c."razonSocial"`;
  const medicos = pf.filter((p) => p.isr >= 100 || (p.medico && p.facturas <= 60));
  let medicosNuevos = 0;
  for (const m of medicos) {
    const existe = await prisma.hospMedico.findFirst({ where: { companyId: cid, rfc: m.rfc }, select: { id: true } });
    if (existe) continue;
    medicosNuevos++;
    const nombre = nombrePropio(m.razon);
    if (dry) { console.log(`  médico: ${nombre} [${m.rfc}] · ${m.facturas} fact · ISR $${r2(m.isr)}`); continue; }
    // El médico factura al hospital: su Supplier canónico (CLABE, pagos) nace
    // aquí si el sync todavía no lo dio de alta.
    const supplier = await prisma.supplier.upsert({
      where: { companyId_rfc: { companyId: cid, rfc: m.rfc } },
      create: { companyId: cid, rfc: m.rfc, razonSocial: m.razon },
      update: {},
      select: { id: true },
    });
    await prisma.hospMedico.create({ data: { companyId: cid, nombre, rfc: m.rfc, supplierId: supplier.id } });
  }
  console.log(`  ✓ médicos: ${medicos.length} candidatos · ${medicosNuevos} nuevos (${pf.length} personas físicas facturan)`);
  });

  // ── 5. Tarifario: conceptos de ingreso recurrentes ────────────────────────
  if (!soloFarmacia) await conReintento("tarifario", async () => {
  const conceptos = await prisma.$queryRaw<Array<{ descripcion: string; clave: string | null; n: number; pu: number[]; fechas: Date[] }>>`
    SELECT it.descripcion, MODE() WITHIN GROUP (ORDER BY it."claveProdServ") AS clave, COUNT(*)::int AS n,
           ARRAY_AGG(it."valorUnitario"::float8 ORDER BY i.fecha DESC) AS pu, ARRAY_AGG(i.fecha ORDER BY i.fecha DESC) AS fechas
    FROM "InvoiceItem" it JOIN "Invoice" i ON i.id = it."invoiceId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'INGRESO' AND i.status <> 'CANCELLED'
      AND it.descripcion !~* 'PACIENTE|\\mPX\\M|\\mVENTA\\M' AND it."claveProdServ" <> '01010101'
    GROUP BY it.descripcion HAVING COUNT(*) >= 3
    ORDER BY n DESC LIMIT 120`;
  const existentes = await prisma.hospServicio.findMany({ where: { companyId: cid }, select: { clave: true, nombre: true } });
  const usadas = new Set(existentes.map((s) => s.clave));
  const nombresExistentes = new Set(existentes.map((s) => normalizarDescripcion(s.nombre)));
  let serviciosNuevos = 0;
  for (const c of conceptos) {
    const nombreNorm = normalizarDescripcion(c.descripcion);
    if (!nombreNorm || nombresExistentes.has(nombreNorm)) continue;
    // Un producto facturado por renglón (EMEND, jeringas, carboplatino…) no es
    // un servicio del tarifario: lo ve farmacia como salida de kardex.
    if (/^(ANTICIPO|COMPRAS|SERVICIOS ADMINISTRATIVOS)\b/.test(nombreNorm)) continue;
    if (!/^FARMACIA\b/.test(nombreNorm) && clasificarInsumo({ claveProdServ: c.clave, descripcion: c.descripcion }).esInsumo) continue;
    // Precio típico: mediana de los últimos 12 meses (o de todo si no hay recientes).
    const hace12 = new Date(); hace12.setMonth(hace12.getMonth() - 12);
    const recientes = c.pu.filter((_, i) => c.fechas[i] >= hace12 && c.pu[i] > 0);
    const precio = r2(mediana(recientes.length >= 3 ? recientes : c.pu.filter((x) => x > 0)));
    if (!(precio > 0)) continue;
    const categoria = categoriaDe(c.descripcion);
    const ivaTasa = /\b0$/.test(nombreNorm) ? 0 : /\b16$/.test(nombreNorm) ? 0.16 : categoria === "HONORARIO" ? null : categoria === "FARMACIA" ? 0 : 0.16;
    serviciosNuevos++;
    nombresExistentes.add(nombreNorm);
    const clave = claveDe(c.descripcion, usadas);
    if (dry) { console.log(`  servicio ${categoria} ${clave}: ${c.descripcion.slice(0, 50)} · ${c.n}× · $${precio}`); continue; }
    await prisma.hospServicio.create({
      data: { companyId: cid, clave, nombre: nombrePropio(c.descripcion).slice(0, 120), categoria, unidad: "servicio", precioLista: precio, ivaTasa, claveProdServ: c.clave },
    });
  }
  console.log(`  ✓ tarifario: ${conceptos.length} conceptos recurrentes · ${serviciosNuevos} servicios nuevos`);
  });

  // ── 6. Pacientes: nombres en los conceptos de ingreso ─────────────────────
  if (!soloFarmacia) await conReintento("pacientes", async () => {
  const lineasPx = await prisma.$queryRaw<Array<{ descripcion: string; fecha: Date; customerId: string | null; crfc: string | null }>>`
    SELECT it.descripcion, i.fecha, i."customerId", c.rfc AS crfc
    FROM "InvoiceItem" it JOIN "Invoice" i ON i.id = it."invoiceId" LEFT JOIN "Customer" c ON c.id = i."customerId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'INGRESO' AND i.status <> 'CANCELLED' AND it.descripcion ~* '\\mPACIENTE\\M|\\mPX\\M'
    ORDER BY i.fecha DESC`;
  const porNombre = new Map<string, { facturas: number; ultima: Date; customerId: string | null }>();
  for (const l of lineasPx) {
    const nombre = nombreDePaciente(l.descripcion);
    if (!nombre) continue;
    const prev = porNombre.get(nombre);
    if (prev) { prev.facturas++; continue; }
    porNombre.set(nombre, { facturas: 1, ultima: l.fecha, customerId: l.crfc && l.crfc.length === 13 ? l.customerId : null });
  }
  let pacientesNuevos = 0;
  for (const [completo, info] of porNombre) {
    const p = partirNombre(completo);
    if (!p.apellidoPaterno) continue;
    const existe = await prisma.hospPaciente.findFirst({
      where: { companyId: cid, nombre: { equals: p.nombre, mode: "insensitive" }, apellidoPaterno: { equals: p.apellidoPaterno, mode: "insensitive" } },
      select: { id: true },
    });
    if (existe) continue;
    pacientesNuevos++;
    if (dry) { console.log(`  paciente: ${p.nombre} ${p.apellidoPaterno} ${p.apellidoMaterno ?? ""} · ${info.facturas} fact`); continue; }
    await prisma.hospPaciente.create({
      data: {
        companyId: cid, nombre: p.nombre, apellidoPaterno: p.apellidoPaterno, apellidoMaterno: p.apellidoMaterno, customerId: info.customerId,
        notas: `Derivado de los CFDIs: ${info.facturas} facturas · última ${info.ultima.toISOString().slice(0, 10)}. Completar datos en la ficha.`,
      },
    });
  }
  console.log(`  ✓ pacientes: ${porNombre.size} nombres en conceptos · ${pacientesNuevos} nuevos`);
  });

  // ── 7. Farmacia: catálogo y kardex desde compras y ventas ─────────────────
  if (!dry && !flag("--sin-farmacia")) {
    let rondas = 0, insumos = 0, movimientos = 0, procesados = 0, fallos = 0;
    for (;;) {
      // El proxy público de Postgres corta conexiones largas (P1017). El
      // barrido es idempotente y guarda su cursor por ronda: se reconecta y
      // sigue; sólo se rinde tras varios cortes seguidos.
      let r: Awaited<ReturnType<typeof derivarInsumosBackfill>>;
      try {
        r = await derivarInsumosBackfill(prisma, cid, { budgetMs: 45_000, page: 100 });
        fallos = 0;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if ((code === "P1017" || code === "P1001" || code === "P2024") && ++fallos <= 8) {
          console.log(`\n  · conexión cortada (${code}); reconectando (${fallos}/8)…`);
          await prisma.$disconnect().catch(() => {});
          await new Promise((res) => setTimeout(res, 3000));
          continue;
        }
        throw e;
      }
      rondas++; insumos += r.insumos; movimientos += r.movimientos; procesados += r.procesados;
      process.stdout.write(`  · farmacia ronda ${rondas}: ${procesados} CFDIs · ${insumos} insumos · ${movimientos} movimientos\r`);
      if (r.completado || r.procesados === 0) break;
      if (rondas > 600) { console.log("\n  ! tope de rondas; sigue con el cron"); break; }
    }
    console.log(`\n  ✓ farmacia: ${procesados} CFDIs barridos · ${insumos} insumos · ${movimientos} movimientos`);
  }

  const [nP, nM, nS, nPx, nI, nL, nMov] = await conReintento("resumen", () => Promise.all([
    prisma.hospPagador.count({ where: { companyId: cid } }),
    prisma.hospMedico.count({ where: { companyId: cid } }),
    prisma.hospServicio.count({ where: { companyId: cid } }),
    prisma.hospPaciente.count({ where: { companyId: cid } }),
    prisma.hospInsumo.count({ where: { companyId: cid } }),
    prisma.hospLote.count({ where: { companyId: cid } }),
    prisma.hospMovimientoInsumo.count({ where: { companyId: cid } }),
  ]));
  console.log(`\n✔ ${company.razonSocial}: ${nP} pagadores · ${nM} médicos · ${nS} servicios · ${nPx} pacientes · ${nI} insumos · ${nL} lotes · ${nMov} movimientos de kardex`);
  console.log("  Falta capturar en pantalla: camas/quirófanos (Censo → Agregar recurso), tabuladores por convenio, especialidades de los médicos y lotes/caducidades al recibir.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
