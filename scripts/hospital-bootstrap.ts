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
 *   · Expedientes — episodios históricos y sus cargos desde los CFDIs de
 *                  ingreso: quién fue atendido, cuándo, de qué y quién pagó
 *                  (episodios-cfdi). El paciente deja de ser un nombre suelto.
 *
 * Nada de esto es la verdad clínica: es el punto de partida para que el
 * hospital corrija en pantalla en vez de capturar de cero. Idempotente: se
 * puede correr las veces que haga falta; no toca lo que ya existe.
 *
 * Uso:
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/hospital-bootstrap.ts \
 *     --rfc CPM2307076Z9 [--nombre "Haltus Hope"] [--admin correo] [--dry-run] [--sin-farmacia]
 *     [--solo-farmacia] [--solo-expedientes] [--desde 2026-01-01] [--hasta 2026-12-31]
 */
import { clasificarProveedorMedico, type ClasificacionProveedor } from "../src/lib/hospital/medicos-cfdi";
import { PrismaClient, type HospPagadorTipo } from "@prisma/client";
import { clasificarInsumo, derivarInsumosBackfill, etiquetarControlados } from "../src/lib/hospital/insumos-cfdi";
// El texto de los CFDIs (categoría, nombre del paciente) es lib compartida:
// la misma regla en el script y en la derivación de expedientes.
import { categoriaDe, nombreDePaciente, nombrePropio, normalizarDescripcion, partirNombre } from "../src/lib/hospital/cfdi-texto";
import { derivarEpisodiosDeCfdi, type ReporteEpisodiosCfdi } from "../src/lib/hospital/episodios-cfdi";

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

const ASEGURADORA_RE =
  /SEGUROS|ASEGURADORA|\bGNP\b|\bAXA\b|METLIFE|MAPFRE|ALLIANZ|BUPA|PLAN SEGURO|INBURSA|CHUBB|ZURICH|\bSURA\b|ATLAS|\bHDI\b|QUALITAS|MONTERREY NEW YORK|GENERAL DE SALUD|MEDICA INTEGRAL|PREVEM|BANORTE|THONA|PAN-AMERICAN|PANAMERICAN|ARGOS/i;
const CONCEPTO_MEDICO_RE = /HONORARIO|MEDIC|CIRUG|ANESTES|CONSULTA|QUIRURG|PROCEDIMIENTO|INTERCONSULTA|VALORACION/i;

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

/** «2026-01-01» → Date; null si no vino. */
function aFecha(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dinero = (n: number) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCorta = (d: Date) => d.toISOString().slice(0, 10);

/** El reporte de la derivación, legible: qué haría y qué no pudo. */
function imprimirExpedientes(r: ReporteEpisodiosCfdi, dry: boolean) {
  const verbo = dry ? "se crearían" : "creados";
  console.log(
    `  ✓ expedientes: ${r.facturas} CFDIs candidatos · ${r.episodios} episodios ${verbo} · ${r.cargos} cargos · ` +
      `${r.pacientesNuevos} pacientes nuevos · ${r.pagadoresNuevos} convenios nuevos · ${r.pacientesConPagador} pacientes heredan convenio`
  );
  if (r.muestra.length) {
    console.log(`  Primeros ${r.muestra.length} episodios:`);
    for (const e of r.muestra) {
      const rango = fechaCorta(e.fechaIngreso) === fechaCorta(e.fechaAlta) ? fechaCorta(e.fechaIngreso) : `${fechaCorta(e.fechaIngreso)} → ${fechaCorta(e.fechaAlta)}`;
      console.log(
        `    · ${e.tipo.padEnd(15)} ${e.paciente} · ${rango} · ${e.facturas.join(", ")} · ${e.cargos} cargo${e.cargos === 1 ? "" : "s"} · ${dinero(e.total)}` +
          (e.pagador ? ` · ${e.pagador}` : "")
      );
    }
  }
  if (r.sinPaciente.length) {
    console.log(`  CFDIs sin paciente identificable (${r.sinPaciente.length}):`);
    for (const f of r.sinPaciente.slice(0, 20)) {
      console.log(`    · ${f.uuid?.slice(0, 8) ?? f.invoiceId} [${f.receptor}] — ${f.motivo}`);
    }
    if (r.sinPaciente.length > 20) console.log(`    … y ${r.sinPaciente.length - 20} más`);
  }
}

async function main() {
  const rfc = arg("--rfc");
  if (!rfc) throw new Error("Uso: --rfc <RFC> [--nombre ...] [--admin correo] [--dry-run] [--sin-farmacia] [--solo-farmacia] [--solo-expedientes]");
  const soloFarmacia = flag("--solo-farmacia");
  const soloExpedientes = flag("--solo-expedientes");
  // Con «--solo-…» sólo corre esa fase: el resto del bootstrap ya se hizo.
  const soloAlgo = soloFarmacia || soloExpedientes;
  const dry = flag("--dry-run");
  const company = await prisma.company.findUnique({ where: { rfc }, select: { id: true, razonSocial: true, nombreComercial: true } });
  if (!company) throw new Error(`No existe empresa con RFC ${rfc}`);
  const cid = company.id;
  console.log(`\n${dry ? "[DRY-RUN] " : ""}${company.razonSocial} (${rfc}) · ${cid}`);

  // ── 1. Módulo, configuración y (opcional) un administrador ────────────────
  if (!dry && !soloAlgo) await conReintento("módulo", async () => {
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
  if (!soloAlgo) await conReintento("pagadores", async () => {
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

  // ── 4. Médicos: personas físicas que facturan SERVICIOS MÉDICOS ──────────
  // Se decide por los conceptos de sus CFDIs (medicos-cfdi.ts), no por la
  // retención de ISR: el arrendador y la imprenta también retienen.
  if (!soloAlgo) await conReintento("médicos", async () => {
  const pf = await prisma.$queryRaw<Array<{ rfc: string; razon: string; facturas: number }>>`
    SELECT c.rfc, c."razonSocial" AS razon, COUNT(DISTINCT i.id)::int AS facturas
    FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
    WHERE i."companyId" = ${cid} AND i.tipo = 'EGRESO' AND i.status <> 'CANCELLED' AND LENGTH(c.rfc) = 13
    GROUP BY c.rfc, c."razonSocial"`;
  const candidatos: Array<{ rfc: string; razon: string; facturas: number; clasificacion: ClasificacionProveedor; proporcion: number; motivos: string[] }> = [];
  for (const p of pf) {
    const conceptos = await prisma.invoiceItem.findMany({
      where: { invoice: { companyId: cid, tipo: "EGRESO", status: { not: "CANCELLED" }, customer: { rfc: p.rfc } } },
      select: { claveProdServ: true, descripcion: true, importe: true, cuentaPredial: true },
    });
    const r = clasificarProveedorMedico(conceptos.map((c) => ({ ...c, importe: Number(c.importe) })));
    if (r.clasificacion === "NO_MEDICO") continue;
    candidatos.push({ rfc: p.rfc, razon: p.razon, facturas: p.facturas, clasificacion: r.clasificacion, proporcion: r.proporcionMedica, motivos: r.motivos });
  }
  let medicosNuevos = 0;
  for (const m of candidatos) {
    const existe = await prisma.hospMedico.findFirst({ where: { companyId: cid, rfc: m.rfc }, select: { id: true } });
    if (existe) continue;
    medicosNuevos++;
    const nombre = nombrePropio(m.razon);
    const revisar = m.clasificacion === "MIXTO" ? ` · MIXTO ${Math.round(m.proporcion * 100)} % médico (${m.motivos.join(", ")}): confirmar` : "";
    if (dry) { console.log(`  médico: ${nombre} [${m.rfc}] · ${m.facturas} fact${revisar}`); continue; }
    if (revisar) console.log(`  ⚠ ${nombre} [${m.rfc}]${revisar}`);
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
  console.log(`  ✓ médicos: ${candidatos.length} candidatos · ${medicosNuevos} nuevos (${pf.length} personas físicas facturan; ${candidatos.filter((c) => c.clasificacion === "MIXTO").length} por confirmar)`);
  });

  // ── 5. Tarifario: conceptos de ingreso recurrentes ────────────────────────
  if (!soloAlgo) await conReintento("tarifario", async () => {
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
  if (!soloAlgo) await conReintento("pacientes", async () => {
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

  // ── 7. Expedientes históricos: episodios y cargos desde los CFDIs ─────────
  // Lo hace la lib (episodios-cfdi.ts): lee por páginas, escribe una
  // transacción por episodio y se reconecta sola si el proxy corta.
  if (!soloFarmacia) {
    const expedientes = await derivarEpisodiosDeCfdi(prisma, cid, {
      dry,
      desde: aFecha(arg("--desde")),
      hasta: aFecha(arg("--hasta")),
      muestra: 10,
      log: (linea) => console.log(linea),
      alReconectar: async () => { await prisma.$disconnect().catch(() => {}); },
    });
    imprimirExpedientes(expedientes, dry);
  }

  // ── 8. Farmacia: catálogo y kardex desde compras y ventas ─────────────────
  if (!dry && !soloExpedientes && !flag("--sin-farmacia")) {
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

    // Controlados (LGS 234/245): los insumos nuevos ya nacen con su grupo
    // propuesto; esto alcanza a los derivados de antes que nadie etiquetó.
    // No toca lo capturado a mano ni lo que ya tiene grupo o sustancia.
    const control = await conReintento("controlados", () => etiquetarControlados(prisma, cid));
    console.log(`  ✓ controlados: ${control.etiquetados} insumos etiquetados por sustancia (${control.revisados} revisados) — confirmar el grupo en Farmacia`);
  }

  const [nP, nM, nS, nPx, nI, nL, nMov, nEp, nEpCfdi] = await conReintento("resumen", () => Promise.all([
    prisma.hospPagador.count({ where: { companyId: cid } }),
    prisma.hospMedico.count({ where: { companyId: cid } }),
    prisma.hospServicio.count({ where: { companyId: cid } }),
    prisma.hospPaciente.count({ where: { companyId: cid } }),
    prisma.hospInsumo.count({ where: { companyId: cid } }),
    prisma.hospLote.count({ where: { companyId: cid } }),
    prisma.hospMovimientoInsumo.count({ where: { companyId: cid } }),
    prisma.hospEpisodio.count({ where: { companyId: cid } }),
    prisma.hospEpisodio.count({ where: { companyId: cid, origen: "CFDI" } }),
  ]));
  console.log(`\n✔ ${company.razonSocial}: ${nP} pagadores · ${nM} médicos · ${nS} servicios · ${nPx} pacientes · ${nEp} episodios (${nEpCfdi} reconstruidos de CFDI) · ${nI} insumos · ${nL} lotes · ${nMov} movimientos de kardex`);
  console.log("  Falta capturar en pantalla: camas/quirófanos (Censo → Agregar recurso), tabuladores por convenio, especialidades de los médicos y lotes/caducidades al recibir.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
