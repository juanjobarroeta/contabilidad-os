/**
 * SEED — el mundo del módulo HOSPITAL tal como lo cuenta la propuesta de
 * Haltus Hope (agosto 2026): censo de 18 camas con 14 ocupadas, la agenda del
 * día sin empalmes, los convenios con su reparto, el expediente y la cuenta
 * de María Fernanda Ortega (HOSP-2026-0418, $50,572 de la propuesta + el
 * midazolam de la inducción), farmacia con lotes y
 * caducidades, honorarios médicos y tickets de mantenimiento.
 *
 * NADA se finge: los datos son ficticios, la maquinaria es la real
 * (crearEpisodio, aplicarInsumo, asegurarCargosEstancia — las mismas reglas
 * que corren las rutas).
 *
 * Uso (DATABASE_URL del .env, como cualquier PrismaClient):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/seed-hospital-demo.ts --company <id>
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/seed-hospital-demo.ts \
 *       --user revisor@haltus.test [--password demo-haltus-2026] [--reset]
 *
 *   --company  empresa existente: habilita HOSPITAL si falta y carga el mundo.
 *   --user     crea al usuario (con --password, bcrypt) si no existe, la
 *              empresa HOSPITAL HALTUS HOPE (RFC ficticio HHH190215K73) con
 *              membresía OWNER y módulos HOSPITAL + CONTABILIDAD.
 *   --reset    borra SOLO las filas Hosp* de esa empresa antes de cargar. Los
 *              datos del hub (clientes, proveedores, CFDIs, banco) se reusan.
 *
 * Idempotente: por clave/folio/nombre; correr dos veces no duplica nada.
 *
 * P1 normativa: requiere los catálogos CIE-10 / CIE-9-MC cargados
 * (scripts/hospital-catalogos.ts). Los pacientes nacen con CURP válida
 * (dígito verificador real), domicilio, número de expediente y aviso de
 * privacidad; los episodios con CIE por catálogo, triage en urgencias, ASA y
 * el límite de 12 h del ambulatorio; las notas con secciones NOM-004 y firma
 * del sistema (crearNota); los consentimientos con su contenido y firmantes;
 * la farmacia con grupo de control, registro sanitario y cadena de frío, y
 * la salida de un controlado amparada por receta.
 */

import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import type { HospArea, HospCargoCategoria, HospEpisodioEstado, HospEpisodioTipo, HospGrupoControl, HospInsumoCategoria, HospMotivoEgreso, HospNotaTipo, HospRecursoTipo } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { seedChartOfAccounts } from "../src/lib/contabilidad/seed-catalog";
import { crearEpisodio } from "../src/lib/hospital/episodio";
import { aplicarInsumo } from "../src/lib/hospital/aplicar-insumo";
import { asegurarCargosEstancia } from "../src/lib/hospital/estancia";
import { siguienteFolio } from "../src/lib/hospital/folio";
import { crearNota } from "../src/lib/hospital/notas";
import { digitoVerificadorCurp, validarCurp } from "../src/lib/hospital/curp";
import { claveDia, fechaLocal, partesLocales } from "../src/lib/hospital/tz";
import { r2 } from "../src/lib/hospital/util";

// ── Identidad fija de la demo ────────────────────────────────────────────────
const DEMO_RFC = "HHH190215K73"; // ficticio
const DEMO_RAZON = "HOSPITAL HALTUS HOPE SA DE CV";
const USUARIO_SEED = "Seed Haltus";
const AVISO_VERSION = "2026-09";
/** Identidad sanitaria ficticia del establecimiento (NOM-024, COFEPRIS). */
const ESTABLECIMIENTO = {
  clues: "PLSMP001234",
  licenciaSanitaria: "COFEPRIS 21-AM-21-114-0034",
  responsableSanitario: "Dra. Patricia Ledesma",
  responsableSanitarioCedula: "5217736",
  avisoPrivacidadVersion: AVISO_VERSION,
  avisoPrivacidadUrl: "https://haltus.test/aviso-de-privacidad",
};

// ── Reloj: todo se expresa en días relativos a HOY (hora local de CDMX) ──────
const ahora = new Date();
const HOY = partesLocales(ahora);
/** Instante local: `dia(-1, 8, 20)` = ayer a las 08:20. */
const dia = (offset: number, h = 0, min = 0) => fechaLocal(HOY.y, HOY.m, HOY.d + offset, h, min);

const uuidDemo = (tag: string): string => {
  const h = createHash("md5").update(`haltus-${tag}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// ── CURP de demo con el algoritmo de RENAPO (persona ficticia, dígito real) ──
const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const VOCALES = "AEIOU";
const primeraVocalInterna = (p: string) => [...p.slice(1)].find((c) => VOCALES.includes(c)) ?? "X";
const primeraConsonanteInterna = (p: string) => {
  const c = [...p.slice(1)].find((x) => /[B-DF-HJ-NP-TV-ZÑ]/.test(x)) ?? "X";
  return c === "Ñ" ? "X" : c;
};
/** Nombre de pila que usa RENAPO: el segundo si el primero es María/José. */
function nombreParaCurp(nombre: string): string {
  const partes = sinAcentos(nombre).split(/\s+/).filter(Boolean);
  const primero = partes[0]?.replace(/\./g, "") ?? "";
  if (partes.length > 1 && ["MARIA", "MA", "JOSE", "J"].includes(primero)) return partes[1];
  return partes[0] ?? "X";
}
function curpDe(p: { nombre: string; apellidoPaterno: string; apellidoMaterno: string | null; sexo: "FEMENINO" | "MASCULINO"; nacimiento: [number, number, number]; entidad: string }): string {
  const pat = sinAcentos(p.apellidoPaterno).replace(/\s+/g, "");
  const mat = sinAcentos(p.apellidoMaterno ?? "").replace(/\s+/g, "");
  const nom = nombreParaCurp(p.nombre);
  const letra = (c: string) => (c === "Ñ" ? "X" : c);
  const [y, m, d] = p.nacimiento;
  const base =
    letra(pat[0]) + primeraVocalInterna(pat) + letra(mat[0] ?? "X") + letra(nom[0]) +
    String(y % 100).padStart(2, "0") + String(m).padStart(2, "0") + String(d).padStart(2, "0") +
    (p.sexo === "MASCULINO" ? "H" : "M") + p.entidad +
    primeraConsonanteInterna(pat) + primeraConsonanteInterna(mat || "XX") + primeraConsonanteInterna(nom) +
    (y >= 2000 ? "A" : "0");
  const curp = base + digitoVerificadorCurp(base);
  const r = validarCurp(curp);
  if (!r.valida) throw new Error(`CURP de demo inválida para ${p.nombre} ${p.apellidoPaterno}: ${curp} (${r.motivo})`);
  return curp;
}

function arg(nombre: string): string | null {
  const args = process.argv.slice(2);
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const flag = (nombre: string) => process.argv.slice(2).includes(nombre);

// ─────────────────────────────────────────────────────────────────────────────
// Empresa y usuario
// ─────────────────────────────────────────────────────────────────────────────

async function resolverEmpresa(): Promise<{ companyId: string; email: string | null }> {
  const companyArg = arg("--company");
  const email = arg("--user")?.toLowerCase().trim() ?? null;
  if (!companyArg && !email) {
    console.error("Uso: seed-hospital-demo.ts --company <id> | --user <email> [--password <pw>] [--reset]");
    process.exit(2);
  }

  if (companyArg) {
    const company = await prisma.company.findUnique({ where: { id: companyArg }, select: { id: true, razonSocial: true } });
    if (!company) throw new Error(`La empresa ${companyArg} no existe.`);
    await prisma.companyModule.upsert({
      where: { companyId_modulo: { companyId: company.id, modulo: "HOSPITAL" } },
      create: { companyId: company.id, modulo: "HOSPITAL" },
      update: { habilitado: true },
    });
    console.log(`· Empresa ${company.razonSocial}: módulo HOSPITAL habilitado`);
    return { companyId: company.id, email: null };
  }

  let user = await prisma.user.findUnique({ where: { email: email! }, select: { id: true } });
  if (!user) {
    const password = arg("--password");
    if (!password) throw new Error(`El usuario ${email} no existe; pásale --password para crearlo.`);
    user = await prisma.user.create({
      data: { email: email!, name: "Revisor Haltus", password: await bcrypt.hash(password, 10) },
      select: { id: true },
    });
    console.log(`· Usuario ${email} creado`);
  }

  let company = await prisma.company.findUnique({ where: { rfc: DEMO_RFC }, select: { id: true } });
  if (!company) {
    company = await prisma.company.create({
      data: {
        rfc: DEMO_RFC,
        razonSocial: DEMO_RAZON,
        nombreComercial: "Haltus Hope",
        regimenFiscal: "601",
        codigoPostal: "72000",
      },
      select: { id: true },
    });
    await seedChartOfAccounts(company.id);
    console.log(`· Empresa ${DEMO_RAZON} (${DEMO_RFC}) creada`);
  }
  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: { userId: user.id, companyId: company.id, role: "OWNER" },
    update: { role: "OWNER" },
  });
  for (const modulo of ["HOSPITAL", "CONTABILIDAD"] as const) {
    await prisma.companyModule.upsert({
      where: { companyId_modulo: { companyId: company.id, modulo } },
      create: { companyId: company.id, modulo },
      update: { habilitado: true },
    });
  }
  return { companyId: company.id, email };
}

/** Borra SOLO las filas del módulo (Hosp*) de la empresa, en orden de dependencias. */
async function borrarHospital(companyId: string) {
  await prisma.hospAcceso.deleteMany({ where: { companyId } });
  await prisma.hospMovimientoInsumo.deleteMany({ where: { companyId } });
  await prisma.hospNota.deleteMany({ where: { episodio: { companyId } } });
  await prisma.hospCargo.deleteMany({ where: { companyId } });
  await prisma.hospSignos.deleteMany({ where: { episodio: { companyId } } });
  await prisma.hospDocumento.deleteMany({ where: { companyId } });
  await prisma.hospTraslado.deleteMany({ where: { episodio: { companyId } } });
  await prisma.hospCita.deleteMany({ where: { companyId } });
  await prisma.hospEpisodio.deleteMany({ where: { companyId } });
  await prisma.hospCotizacionPartida.deleteMany({ where: { cotizacion: { companyId } } });
  await prisma.hospCotizacion.deleteMany({ where: { companyId } });
  await prisma.hospLote.deleteMany({ where: { companyId } });
  await prisma.hospInsumo.deleteMany({ where: { companyId } });
  await prisma.hospTarifa.deleteMany({ where: { servicio: { companyId } } });
  await prisma.hospRecurso.deleteMany({ where: { companyId } });
  await prisma.hospServicio.deleteMany({ where: { companyId } });
  await prisma.hospMedico.deleteMany({ where: { companyId } });
  await prisma.hospPaciente.deleteMany({ where: { companyId } });
  await prisma.hospPagador.deleteMany({ where: { companyId } });
  await prisma.hospTicket.deleteMany({ where: { companyId } });
  await prisma.hospConfig.deleteMany({ where: { companyId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogos
// ─────────────────────────────────────────────────────────────────────────────

async function customer(companyId: string, rfc: string, razonSocial: string, extra: { regimenFiscal?: string; codigoPostal?: string } = {}) {
  return prisma.customer.upsert({
    where: { companyId_rfc: { companyId, rfc } },
    create: { companyId, rfc, razonSocial, regimenFiscal: extra.regimenFiscal ?? "601", codigoPostal: extra.codigoPostal ?? "72000" },
    update: {},
  });
}

async function supplier(companyId: string, rfc: string, razonSocial: string, clabe: string) {
  return prisma.supplier.upsert({
    where: { companyId_rfc: { companyId, rfc } },
    create: { companyId, rfc, razonSocial, regimenFiscal: "612", clabe, banco: "BBVA", titularCuenta: razonSocial },
    update: {},
  });
}

const SERVICIOS: Array<{
  clave: string;
  nombre: string;
  categoria: HospCargoCategoria;
  unidad: string;
  precioLista: number;
  ivaTasa: number | null;
  tarifas?: Record<string, number>;
  claveProdServ?: string;
}> = [
  { clave: "HAB-STD", nombre: "Habitación estándar", categoria: "HABITACION", unidad: "noche", precioLista: 3200, ivaTasa: 0.16, tarifas: { GNP: 3200, AXA: 3050, TEXTIL: 2900 }, claveProdServ: "85101601" },
  { clave: "HAB-SUI", nombre: "Habitación suite", categoria: "HABITACION", unidad: "noche", precioLista: 5400, ivaTasa: 0.16, claveProdServ: "85101601" },
  { clave: "REC-HORA", nombre: "Sala de recuperación", categoria: "HABITACION", unidad: "hora", precioLista: 1300, ivaTasa: 0.16 },
  { clave: "QX-HORA", nombre: "Uso de quirófano", categoria: "QUIROFANO", unidad: "hora", precioLista: 4800, ivaTasa: 0.16, tarifas: { GNP: 4800, AXA: 4600 }, claveProdServ: "85101602" },
  { clave: "URG-VAL", nombre: "Valoración en urgencias", categoria: "URGENCIAS", unidad: "servicio", precioLista: 1150, ivaTasa: 0.16 },
  { clave: "PROC-COLE", nombre: "Colecistectomía laparoscópica (paquete quirúrgico)", categoria: "PROCEDIMIENTO", unidad: "servicio", precioLista: 32600, ivaTasa: 0.16, tarifas: { GNP: 32600, AXA: 31200 } },
  { clave: "PROC-HERN", nombre: "Hernioplastía inguinal (paquete quirúrgico)", categoria: "PROCEDIMIENTO", unidad: "servicio", precioLista: 24800, ivaTasa: 0.16, tarifas: { AXA: 23900 } },
  { clave: "PROC-SAFE", nombre: "Safenectomía (paquete quirúrgico)", categoria: "PROCEDIMIENTO", unidad: "servicio", precioLista: 21400, ivaTasa: 0.16, tarifas: { TEXTIL: 20500 } },
  { clave: "PROC-ARTRO", nombre: "Artroscopía de rodilla (paquete quirúrgico)", categoria: "PROCEDIMIENTO", unidad: "servicio", precioLista: 38900, ivaTasa: 0.16 },
  { clave: "PROC-PANEN", nombre: "Panendoscopía", categoria: "PROCEDIMIENTO", unidad: "servicio", precioLista: 7800, ivaTasa: 0.16 },
  { clave: "EST-HISTO", nombre: "Estudio histopatológico", categoria: "ESTUDIO", unidad: "estudio", precioLista: 1420, ivaTasa: 0.16 },
  { clave: "EST-LABPRE", nombre: "Laboratorio preoperatorio (BH, QS, TP/TPT)", categoria: "ESTUDIO", unidad: "estudio", precioLista: 680, ivaTasa: 0.16 },
  { clave: "EST-RX", nombre: "Radiografía simple", categoria: "ESTUDIO", unidad: "estudio", precioLista: 520, ivaTasa: 0.16 },
  { clave: "CONS-EXT", nombre: "Consulta externa", categoria: "PROCEDIMIENTO", unidad: "consulta", precioLista: 850, ivaTasa: null },
  { clave: "HON-CIR", nombre: "Honorarios quirúrgicos", categoria: "HONORARIO", unidad: "servicio", precioLista: 18000, ivaTasa: null },
  { clave: "HON-ANES", nombre: "Honorarios de anestesiología", categoria: "HONORARIO", unidad: "servicio", precioLista: 8500, ivaTasa: null },
  { clave: "PAQ-HOSP2", nombre: "Hospitalización 2 noches (paquete)", categoria: "HABITACION", unidad: "paquete", precioLista: 6400, ivaTasa: 0.16 },
];

const PAGADORES = [
  { key: "GNP", nombre: "GNP Seguros", tipo: "ASEGURADORA", tabulador: "GNP 2026", deducible: 8500, coaseguroPct: 0.1, plazoDias: 45, topeAutorizacion: 60000, vigenciaInicio: fechaLocal(2026, 1, 1), vigenciaFin: fechaLocal(2026, 12, 31, 23, 59), rfc: "GSE930415KL7", razon: "GNP SEGUROS SA DE CV", cp: "11000" },
  { key: "AXA", nombre: "AXA Seguros", tipo: "ASEGURADORA", tabulador: "AXA red", deducible: 12000, coaseguroPct: 0.1, plazoDias: 60, topeAutorizacion: 80000, vigenciaInicio: fechaLocal(2025, 7, 1), vigenciaFin: fechaLocal(2027, 6, 30, 23, 59), rfc: "ASE020412QX9", razon: "AXA SEGUROS SA DE CV", cp: "06600" },
  { key: "TEXTIL", nombre: "Textil del Valle", tipo: "EMPRESA", tabulador: "Empresa A", deducible: null, coaseguroPct: 0, plazoDias: 30, topeAutorizacion: null, vigenciaInicio: dia(-343), vigenciaFin: dia(22, 23, 59), rfc: "TVA050718MN3", razon: "TEXTIL DEL VALLE SA DE CV", cp: "72810" },
  { key: "PART", nombre: "Particular", tipo: "PARTICULAR", tabulador: "Lista", deducible: null, coaseguroPct: null, plazoDias: 0, topeAutorizacion: null, vigenciaInicio: null, vigenciaFin: null, rfc: null, razon: null, cp: null },
] as const;

const MEDICOS = [
  { key: "VEGA", nombre: "Dr. Alonso Vega", especialidad: "Cirugía general", cedula: "5583201", rfc: "VEAA750312HN5", razon: "ALONSO VEGA ARRIAGA", clabe: "012180012345678901" },
  { key: "RENTERIA", nombre: "Dra. Claudia Rentería", especialidad: "Anestesiología", cedula: "6120944", rfc: "REAC800521MP2", razon: "CLAUDIA RENTERIA AGUIRRE", clabe: "012180012345678902" },
  { key: "SANDOVAL", nombre: "Dr. Ernesto Sandoval", especialidad: "Cirugía general", cedula: "4471180", rfc: "SAEE701105KQ8", razon: "ERNESTO SANDOVAL ESCOBEDO", clabe: "012180012345678903" },
  { key: "IBARRA", nombre: "Dra. Mónica Ibarra", especialidad: "Angiología", cedula: "6893310", rfc: "IAMM830914RT4", razon: "MONICA IBARRA MORALES", clabe: "012180012345678904" },
  { key: "LEDESMA", nombre: "Dra. Patricia Ledesma", especialidad: "Medicina interna", cedula: "5217736", rfc: "LEPP770228JW6", razon: null, clabe: null },
  { key: "FUENTES", nombre: "Dr. Javier Fuentes", especialidad: "Ortopedia y traumatología", cedula: "5804412", rfc: "FUJJ790610GC1", razon: null, clabe: null },
] as const;

const CAMAS: Array<{ nombre: string; area: HospArea; estado?: "LIBRE" | "LIMPIEZA"; servicio: string | null; orden: number }> = [
  ...["201", "202", "203", "204", "205", "206", "207", "208"].map((n, i) => ({ nombre: n, area: "HOSPITALIZACION" as HospArea, servicio: "HAB-STD", orden: 10 + i })),
  ...["211", "212", "213", "214"].map((n, i) => ({ nombre: n, area: "URGENCIAS" as HospArea, servicio: null, orden: 30 + i })),
  ...["221", "222", "223", "224", "225", "226"].map((n, i) => ({ nombre: n, area: "RECUPERACION" as HospArea, servicio: "HAB-STD", orden: 50 + i })),
];

const SALAS: Array<{ nombre: string; tipo: HospRecursoTipo; area: HospArea; servicio: string | null; orden: number }> = [
  { nombre: "Quirófano 1", tipo: "QUIROFANO", area: "QUIROFANO", servicio: "QX-HORA", orden: 1 },
  { nombre: "Quirófano 2", tipo: "QUIROFANO", area: "QUIROFANO", servicio: "QX-HORA", orden: 2 },
  { nombre: "Endoscopía", tipo: "SALA", area: "ENDOSCOPIA", servicio: null, orden: 3 },
  { nombre: "Consultorio A", tipo: "CONSULTORIO", area: "CONSULTA_EXTERNA", servicio: "CONS-EXT", orden: 4 },
];

const INSUMOS: Array<{
  clave: string;
  nombre: string;
  presentacion: string;
  unidad: string;
  categoria: HospInsumoCategoria;
  controlado?: boolean;
  /** Fracción de la LGS (arts. 234/245): I-III exigen receta y libro de control. */
  grupoControl?: HospGrupoControl;
  sustanciaActiva?: string;
  registroSanitario?: string;
  requiereRefrigeracion?: boolean;
  minimo: number;
  precioVenta: number;
  ivaTasa: number | null;
  lote: { lote: string; caducidad: Date | null; existencia: number; costoUnitario: number };
}> = [
  { clave: "MED-CEFA1G", nombre: "Cefalotina 1 g sol. iny.", presentacion: "Frasco ámpula 1 g", unidad: "pz", categoria: "MEDICAMENTO", sustanciaActiva: "Cefalotina", registroSanitario: "83421 SSA IV", minimo: 60, precioVenta: 85, ivaTasa: 0, lote: { lote: "L-2291", caducidad: fechaLocal(2027, 3, 31), existencia: 148, costoUnitario: 61.4 } },
  { clave: "MED-KETO30", nombre: "Ketorolaco 30 mg sol. iny.", presentacion: "Ampolleta 1 ml", unidad: "pz", categoria: "MEDICAMENTO", sustanciaActiva: "Ketorolaco", registroSanitario: "268M2001 SSA IV", minimo: 40, precioVenta: 28, ivaTasa: 0, lote: { lote: "K-8830", caducidad: dia(54), existencia: 62, costoUnitario: 12.5 } },
  { clave: "MED-PROPO200", nombre: "Propofol 200 mg", presentacion: "Ampolleta 20 ml", unidad: "pz", categoria: "MEDICAMENTO", sustanciaActiva: "Propofol", registroSanitario: "532M2004 SSA IV", minimo: 25, precioVenta: 214, ivaTasa: 0, lote: { lote: "P-1174", caducidad: dia(31), existencia: 9, costoUnitario: 150 } },
  { clave: "SOL-HART1000", nombre: "Solución Hartmann 1000 ml", presentacion: "Bolsa 1000 ml", unidad: "pz", categoria: "SOLUCION", registroSanitario: "77315 SSA IV", minimo: 120, precioVenta: 62, ivaTasa: 0, lote: { lote: "H-0455", caducidad: fechaLocal(2028, 6, 30), existencia: 310, costoUnitario: 38 } },
  // Controlados: midazolam (grupo III, receta ordinaria retenida) y fentanilo
  // (grupo I, receta especial con código de barras); ambos van al libro.
  { clave: "MED-MIDA5", nombre: "Midazolam 5 mg sol. iny.", presentacion: "Ampolleta 5 ml", unidad: "pz", categoria: "MEDICAMENTO", controlado: true, grupoControl: "III", sustanciaActiva: "Midazolam", registroSanitario: "096M96 SSA IV", minimo: 30, precioVenta: 96, ivaTasa: 0, lote: { lote: "M-0912", caducidad: fechaLocal(2027, 1, 31), existencia: 24, costoUnitario: 45 } },
  { clave: "MED-FENT05", nombre: "Fentanilo 0.5 mg/10 ml sol. iny.", presentacion: "Ampolleta 10 ml", unidad: "pz", categoria: "MEDICAMENTO", controlado: true, grupoControl: "I", sustanciaActiva: "Fentanilo", registroSanitario: "062M2012 SSA IV", minimo: 20, precioVenta: 118, ivaTasa: 0, lote: { lote: "F-0207", caducidad: fechaLocal(2027, 5, 31), existencia: 30, costoUnitario: 52 } },
  // Cadena de frío: exige registro de temperatura en almacén (FEUM).
  { clave: "MED-INSU100", nombre: "Insulina humana NPH 100 UI/ml", presentacion: "Frasco ámpula 10 ml", unidad: "pz", categoria: "MEDICAMENTO", sustanciaActiva: "Insulina humana", registroSanitario: "541M2009 SSA IV", requiereRefrigeracion: true, minimo: 8, precioVenta: 320, ivaTasa: 0, lote: { lote: "I-4410", caducidad: fechaLocal(2027, 2, 28), existencia: 14, costoUnitario: 186 } },
  { clave: "MAT-JER5", nombre: "Jeringa 5 ml", presentacion: "Pieza estéril", unidad: "pz", categoria: "MATERIAL_CURACION", minimo: 300, precioVenta: 6, ivaTasa: 0.16, lote: { lote: "J-1188", caducidad: fechaLocal(2028, 2, 28), existencia: 900, costoUnitario: 2.4 } },
  { clave: "MAT-GASA10", nombre: "Gasa estéril 10×10", presentacion: "Paquete 10 pz", unidad: "paq", categoria: "MATERIAL_CURACION", minimo: 150, precioVenta: 18, ivaTasa: 0.16, lote: { lote: "G-3320", caducidad: fechaLocal(2027, 11, 30), existencia: 420, costoUnitario: 9.5 } },
  { clave: "EQ-OXIM", nombre: "Oxímetro desechable", presentacion: "Sensor adulto", unidad: "pz", categoria: "EQUIPO", minimo: 10, precioVenta: 390, ivaTasa: 0.16, lote: { lote: "O-0071", caducidad: fechaLocal(2027, 8, 31), existencia: 35, costoUnitario: 210 } },
];

// Lo que sale de farmacia por aplicación real: el lote nace con ESTA cantidad
// de más para que, tras la aplicación, la existencia quede como en la lámina.
// (Ortega: cefalotina, propofol, Hartmann y midazolam; la consulta externa de
// Montes: un ketorolaco vendido, 0 % de IVA.)
const APLICADO_ORTEGA: Record<string, number> = { "MED-CEFA1G": 6, "MED-PROPO200": 1, "SOL-HART1000": 4, "MED-MIDA5": 1, "MED-KETO30": 1 };

type Pac = {
  key: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  sexo: "FEMENINO" | "MASCULINO";
  nacimiento: [number, number, number];
  /** Entidad de nacimiento como la codifica la CURP (PL = Puebla). */
  entidad: string;
  pagador: string;
  telefono?: string;
  tipoSangre?: string;
  alergias?: string;
  domicilio: { calle: string; numeroExterior: string; numeroInterior?: string; colonia: string; municipio: string; estado: string; codigoPostal: string };
  /** false = todavía no acepta el aviso de privacidad (alerta en el panel). */
  aviso?: boolean;
};

const PUEBLA = { municipio: "Puebla", estado: "Puebla" };
const PACIENTES: Pac[] = [
  { key: "ORTEGA", nombre: "María Fernanda", apellidoPaterno: "Ortega", apellidoMaterno: "Ruiz", sexo: "FEMENINO", nacimiento: [1992, 3, 14], entidad: "PL", pagador: "GNP", telefono: "222 431 8890", tipoSangre: "O+", alergias: "Sin alergias conocidas", domicilio: { calle: "Av. Juárez", numeroExterior: "2915", numeroInterior: "4B", colonia: "La Paz", ...PUEBLA, codigoPostal: "72160" } },
  { key: "PENA", nombre: "Jorge Luis", apellidoPaterno: "Peña", apellidoMaterno: "Cárdenas", sexo: "MASCULINO", nacimiento: [1968, 6, 2], entidad: "PL", pagador: "AXA", telefono: "222 118 4471", domicilio: { calle: "16 de Septiembre", numeroExterior: "1408", colonia: "Centro", ...PUEBLA, codigoPostal: "72000" } },
  { key: "MARQUEZ", nombre: "Silvia", apellidoPaterno: "Márquez", apellidoMaterno: "Toledo", sexo: "FEMENINO", nacimiento: [1985, 1, 22], entidad: "TL", pagador: "TEXTIL", telefono: "222 905 3312", domicilio: { calle: "Calle 5 Sur", numeroExterior: "312", colonia: "San Pedro", municipio: "San Pedro Cholula", estado: "Puebla", codigoPostal: "72760" } },
  { key: "AGUILAR", nombre: "Ramón", apellidoPaterno: "Aguilar", apellidoMaterno: "Ceballos", sexo: "MASCULINO", nacimiento: [1960, 4, 9], entidad: "VZ", pagador: "AXA", telefono: "222 660 2098", domicilio: { calle: "Priv. Los Pinos", numeroExterior: "7", colonia: "Las Ánimas", ...PUEBLA, codigoPostal: "72400" }, aviso: false },
  { key: "VILLALOBOS", nombre: "Carmen", apellidoPaterno: "Villalobos", apellidoMaterno: "Sanz", sexo: "FEMENINO", nacimiento: [1979, 8, 30], entidad: "PL", pagador: "PART", domicilio: { calle: "Blvd. Atlixco", numeroExterior: "2301", colonia: "Zona Esmeralda", ...PUEBLA, codigoPostal: "72190" } },
  { key: "NIETO", nombre: "Andrea", apellidoPaterno: "Nieto", apellidoMaterno: "Camargo", sexo: "FEMENINO", nacimiento: [1997, 5, 11], entidad: "PL", pagador: "PART", domicilio: { calle: "Calle 27 Poniente", numeroExterior: "1102", colonia: "Chulavista", ...PUEBLA, codigoPostal: "72420" } },
  { key: "TAPIA", nombre: "Gerardo", apellidoPaterno: "Tapia", apellidoMaterno: "Rendón", sexo: "MASCULINO", nacimiento: [1963, 10, 3], entidad: "MC", pagador: "GNP", domicilio: { calle: "Av. Reforma", numeroExterior: "504", colonia: "Centro", ...PUEBLA, codigoPostal: "72000" } },
  { key: "BERMUDEZ", nombre: "Ana Sofía", apellidoPaterno: "Bermúdez", apellidoMaterno: "Lara", sexo: "FEMENINO", nacimiento: [1990, 2, 17], entidad: "PL", pagador: "TEXTIL", domicilio: { calle: "Calle 9 Norte", numeroExterior: "805", colonia: "Santa María", ...PUEBLA, codigoPostal: "72080" } },
  { key: "CIFUENTES", nombre: "Norma Elena", apellidoPaterno: "Cifuentes", apellidoMaterno: "Robles", sexo: "FEMENINO", nacimiento: [1974, 7, 8], entidad: "DF", pagador: "GNP", domicilio: { calle: "Circuito Juan Pablo II", numeroExterior: "1420", colonia: "Las Ánimas", ...PUEBLA, codigoPostal: "72400" } },
  { key: "RUVALCABA", nombre: "Héctor Manuel", apellidoPaterno: "Ruvalcaba", apellidoMaterno: "Ortiz", sexo: "MASCULINO", nacimiento: [1981, 11, 25], entidad: "PL", pagador: "PART", domicilio: { calle: "Av. 31 Poniente", numeroExterior: "3703", colonia: "Belisario Domínguez", ...PUEBLA, codigoPostal: "72180" } },
  { key: "ESPARZA", nombre: "Lucía", apellidoPaterno: "Esparza", apellidoMaterno: "Medina", sexo: "FEMENINO", nacimiento: [1988, 9, 19], entidad: "OC", pagador: "AXA", domicilio: { calle: "Calle 11 Sur", numeroExterior: "5110", colonia: "Prados Agua Azul", ...PUEBLA, codigoPostal: "72430" } },
  { key: "HERRERA", nombre: "Tomás", apellidoPaterno: "Herrera", apellidoMaterno: "Quintero", sexo: "MASCULINO", nacimiento: [1955, 3, 2], entidad: "PL", pagador: "GNP", domicilio: { calle: "Av. Hidalgo", numeroExterior: "210", colonia: "Centro", municipio: "Atlixco", estado: "Puebla", codigoPostal: "74200" } },
  { key: "OLVERA", nombre: "Patricia", apellidoPaterno: "Olvera", apellidoMaterno: "Sánchez", sexo: "FEMENINO", nacimiento: [1971, 6, 27], entidad: "PL", pagador: "GNP", domicilio: { calle: "Calle 43 Oriente", numeroExterior: "1618", colonia: "Huexotitla", ...PUEBLA, codigoPostal: "72534" } },
  { key: "CORDERO", nombre: "Miguel Ángel", apellidoPaterno: "Cordero", apellidoMaterno: "Ruiz", sexo: "MASCULINO", nacimiento: [1977, 1, 9], entidad: "PL", pagador: "TEXTIL", domicilio: { calle: "Priv. Volcanes", numeroExterior: "18", colonia: "Volcanes", ...PUEBLA, codigoPostal: "72410" } },
  { key: "DELGADO", nombre: "Rosa María", apellidoPaterno: "Delgado", apellidoMaterno: "Paz", sexo: "FEMENINO", nacimiento: [1966, 12, 12], entidad: "PL", pagador: "AXA", domicilio: { calle: "Av. Forjadores", numeroExterior: "1009", colonia: "Momoxpan", municipio: "San Pedro Cholula", estado: "Puebla", codigoPostal: "72754" } },
  { key: "ALCANTARA", nombre: "Fernando", apellidoPaterno: "Alcántara", apellidoMaterno: "Ríos", sexo: "MASCULINO", nacimiento: [1982, 4, 4], entidad: "MC", pagador: "AXA", domicilio: { calle: "Calle 2 Oriente", numeroExterior: "1213", colonia: "Centro", ...PUEBLA, codigoPostal: "72000" } },
  { key: "ZAMORA", nombre: "Beatriz", apellidoPaterno: "Zamora", apellidoMaterno: "Luna", sexo: "FEMENINO", nacimiento: [1993, 8, 21], entidad: "PL", pagador: "PART", domicilio: { calle: "Av. Zavaleta", numeroExterior: "3922", colonia: "Santa Cruz Buenavista", ...PUEBLA, codigoPostal: "72150" } },
  { key: "MONTES", nombre: "Alejandro", apellidoPaterno: "Montes", apellidoMaterno: "Pineda", sexo: "MASCULINO", nacimiento: [1976, 2, 28], entidad: "PL", pagador: "AXA", domicilio: { calle: "Calle 25 Sur", numeroExterior: "3105", colonia: "Anzures", ...PUEBLA, codigoPostal: "72530" } },
  { key: "AVILA", nombre: "Verónica", apellidoPaterno: "Ávila", apellidoMaterno: "Serrano", sexo: "FEMENINO", nacimiento: [1980, 5, 5], entidad: "PL", pagador: "TEXTIL", domicilio: { calle: "Blvd. 5 de Mayo", numeroExterior: "2802", colonia: "Rincón Arboledas", ...PUEBLA, codigoPostal: "72470" } },
];

type Ep = {
  folio: string;
  paciente: string;
  /** null = sin cama (consulta externa). */
  cama: string | null;
  tipo: HospEpisodioTipo;
  estado: HospEpisodioEstado;
  ingreso: [number, number, number];
  medico: string;
  dx: string;
  /** CIE-10 en la forma clínica de la DGIS («K80.2», «I10.X»). */
  cie10: string;
  /** CIE-9-MC del procedimiento («51.23»). */
  cie9?: string;
  procedimiento?: string;
  motivo?: string;
  /** Triage 1-5 (obligatorio en URGENCIAS, NOM-027). */
  triage?: number;
  /** Clasificación ASA (NOM-026). */
  asa?: string;
  honorario?: { medico: string; monto: number; servicio: string };
  cargos?: Array<{ servicio: string; cantidad: number }>;
  alta?: {
    fecha: [number, number, number];
    camaDespues: "LIMPIEZA" | "LIBRE";
    motivo: HospMotivoEgreso;
    /** CIE-10 de egreso; default: el de ingreso. */
    cie10?: string;
    /** Aldrete al egreso (ambulatorio: ≥ 9). */
    aldrete?: number;
    /** Llamada de seguimiento (NOM-026): días después del alta y nota. */
    seguimiento?: { dias: number; nota: string };
  };
};

const EPISODIOS: Ep[] = [
  // Historia de agosto (facturadas y cobradas): alimentan honorarios del mes anterior.
  { folio: "HOSP-2026-0392", paciente: "MONTES", cama: "203", tipo: "HOSPITALIZACION", estado: "ALTA", ingreso: [-24, 7, 30], medico: "SANDOVAL", dx: "Hernia inguinal unilateral", cie10: "K40.9", cie9: "53.05", procedimiento: "Hernioplastía inguinal", asa: "I", honorario: { medico: "SANDOVAL", monto: 24000, servicio: "HON-CIR" }, cargos: [{ servicio: "PROC-HERN", cantidad: 1 }, { servicio: "EST-LABPRE", cantidad: 1 }], alta: { fecha: [-22, 12, 0], camaDespues: "LIBRE", motivo: "CURACION" } },
  { folio: "HOSP-2026-0401", paciente: "AVILA", cama: "205", tipo: "HOSPITALIZACION", estado: "ALTA", ingreso: [-16, 8, 0], medico: "IBARRA", dx: "Várices de miembros inferiores", cie10: "I83.9", cie9: "38.59", procedimiento: "Safenectomía", asa: "I", honorario: { medico: "IBARRA", monto: 15500, servicio: "HON-CIR" }, cargos: [{ servicio: "PROC-SAFE", cantidad: 1 }], alta: { fecha: [-15, 13, 0], camaDespues: "LIBRE", motivo: "MEJORIA" } },
  // Cirugía ambulatoria cerrada como pide la NOM-026: egreso antes de 12 h con
  // Aldrete 10 y llamada de seguimiento al día siguiente.
  { folio: "HOSP-2026-0405", paciente: "ZAMORA", cama: "223", tipo: "AMBULATORIO", estado: "ALTA", ingreso: [-9, 7, 0], medico: "RENTERIA", dx: "Enfermedad por reflujo gastroesofágico", cie10: "K21.9", cie9: "45.13", procedimiento: "Panendoscopía", asa: "I", honorario: { medico: "RENTERIA", monto: 4200, servicio: "HON-ANES" }, cargos: [{ servicio: "PROC-PANEN", cantidad: 1 }], alta: { fecha: [-9, 13, 30], camaDespues: "LIBRE", motivo: "MEJORIA", aldrete: 10, seguimiento: { dias: 1, nota: "Llamada de seguimiento: sin dolor ni sangrado, tolera dieta; se recuerda cita de resultados." } } },
  // Altas de hoy (ya salieron): 202 quedó en limpieza; 225 y 226 ya se limpiaron.
  { folio: "HOSP-2026-0410", paciente: "CIFUENTES", cama: "202", tipo: "HOSPITALIZACION", estado: "ALTA", ingreso: [-3, 9, 10], medico: "LEDESMA", dx: "Neumonía adquirida en la comunidad", cie10: "J18.9", alta: { fecha: [0, 8, 45], camaDespues: "LIMPIEZA", motivo: "MEJORIA" } },
  { folio: "HOSP-2026-0413", paciente: "ALCANTARA", cama: "225", tipo: "HOSPITALIZACION", estado: "ALTA", ingreso: [-2, 7, 0], medico: "SANDOVAL", dx: "Apendicitis aguda", cie10: "K35.8", cie9: "47.01", procedimiento: "Apendicectomía laparoscópica", asa: "I", honorario: { medico: "SANDOVAL", monto: 19500, servicio: "HON-CIR" }, alta: { fecha: [0, 7, 30], camaDespues: "LIBRE", motivo: "CURACION" } },
  { folio: "HOSP-2026-0415", paciente: "ZAMORA", cama: "226", tipo: "HOSPITALIZACION", estado: "ALTA", ingreso: [-1, 6, 40], medico: "LEDESMA", dx: "Gastroenteritis con deshidratación", cie10: "A09.9", alta: { fecha: [0, 8, 10], camaDespues: "LIBRE", motivo: "MEJORIA" } },
  // Hospitalización (201–208): 202 limpieza, 203 libre, seis ocupadas.
  { folio: "HOSP-2026-0411", paciente: "PENA", cama: "201", tipo: "HOSPITALIZACION", estado: "HOSPITALIZADO", ingreso: [-2, 7, 15], medico: "SANDOVAL", dx: "Hernia inguinal derecha", cie10: "K40.9", cie9: "53.05", procedimiento: "Hernioplastía inguinal", asa: "II", honorario: { medico: "SANDOVAL", monto: 24000, servicio: "HON-CIR" }, cargos: [{ servicio: "EST-LABPRE", cantidad: 1 }] },
  { folio: "HOSP-2026-0418", paciente: "ORTEGA", cama: "204", tipo: "HOSPITALIZACION", estado: "POSTOPERATORIO", ingreso: [-1, 8, 20], medico: "VEGA", dx: "Cálculo de vesícula biliar", cie10: "K80.2", cie9: "51.23", procedimiento: "Colecistectomía laparoscópica", asa: "I", motivo: "Programada para colecistectomía laparoscópica" },
  { folio: "HOSP-2026-0420", paciente: "NIETO", cama: "205", tipo: "HOSPITALIZACION", estado: "HOSPITALIZADO", ingreso: [0, 7, 50], medico: "SANDOVAL", dx: "Dolor abdominal en estudio", cie10: "R10.4" },
  { folio: "HOSP-2026-0409", paciente: "TAPIA", cama: "206", tipo: "HOSPITALIZACION", estado: "HOSPITALIZADO", ingreso: [-4, 10, 5], medico: "VEGA", dx: "Oclusión intestinal resuelta", cie10: "K56.6", cie9: "54.11", procedimiento: "Laparotomía exploradora", asa: "III", honorario: { medico: "VEGA", monto: 32000, servicio: "HON-CIR" } },
  { folio: "HOSP-2026-0419", paciente: "VILLALOBOS", cama: "207", tipo: "AMBULATORIO", estado: "POSTOPERATORIO", ingreso: [0, 7, 0], medico: "RENTERIA", dx: "Enfermedad por reflujo gastroesofágico", cie10: "K21.9", cie9: "45.13", procedimiento: "Panendoscopía", asa: "I", honorario: { medico: "RENTERIA", monto: 4200, servicio: "HON-ANES" }, cargos: [{ servicio: "PROC-PANEN", cantidad: 1 }] },
  { folio: "HOSP-2026-0414", paciente: "BERMUDEZ", cama: "208", tipo: "HOSPITALIZACION", estado: "HOSPITALIZADO", ingreso: [-1, 11, 30], medico: "LEDESMA", dx: "Pielonefritis aguda", cie10: "N10.X" },
  // Urgencias (211–214): las cuatro ocupadas, todas con triage (NOM-027).
  { folio: "HOSP-2026-0422", paciente: "AGUILAR", cama: "211", tipo: "URGENCIAS", estado: "EN_VALORACION", ingreso: [0, 6, 15], medico: "FUENTES", dx: "Lesión de menisco medial", cie10: "S83.2", cie9: "80.26", procedimiento: "Artroscopía de rodilla", triage: 3, cargos: [{ servicio: "URG-VAL", cantidad: 1 }, { servicio: "EST-RX", cantidad: 2 }] },
  { folio: "HOSP-2026-0416", paciente: "RUVALCABA", cama: "212", tipo: "URGENCIAS", estado: "EN_VALORACION", ingreso: [-1, 22, 40], medico: "LEDESMA", dx: "Crisis hipertensiva", cie10: "I10.X", triage: 2, cargos: [{ servicio: "URG-VAL", cantidad: 1 }] },
  { folio: "HOSP-2026-0423", paciente: "ESPARZA", cama: "213", tipo: "URGENCIAS", estado: "EN_VALORACION", ingreso: [0, 5, 20], medico: "LEDESMA", dx: "Cólico renal", cie10: "N23.X", triage: 3, cargos: [{ servicio: "URG-VAL", cantidad: 1 }] },
  { folio: "HOSP-2026-0417", paciente: "HERRERA", cama: "214", tipo: "URGENCIAS", estado: "EN_VALORACION", ingreso: [-1, 19, 5], medico: "FUENTES", dx: "Fractura de cadera", cie10: "S72.0", triage: 2, cargos: [{ servicio: "URG-VAL", cantidad: 1 }, { servicio: "EST-RX", cantidad: 3 }] },
  // Recuperación (221–226): cuatro ocupadas, 225 y 226 libres.
  { folio: "HOSP-2026-0421", paciente: "MARQUEZ", cama: "221", tipo: "HOSPITALIZACION", estado: "PREOPERATORIO", ingreso: [0, 7, 30], medico: "IBARRA", dx: "Insuficiencia venosa crónica", cie10: "I87.2", cie9: "38.59", procedimiento: "Safenectomía", asa: "I" },
  { folio: "HOSP-2026-0424", paciente: "OLVERA", cama: "222", tipo: "HOSPITALIZACION", estado: "POSTOPERATORIO", ingreso: [0, 6, 50], medico: "VEGA", dx: "Hernia umbilical", cie10: "K42.9", cie9: "53.49", procedimiento: "Plastía umbilical", asa: "II", honorario: { medico: "VEGA", monto: 14500, servicio: "HON-CIR" } },
  { folio: "HOSP-2026-0412", paciente: "CORDERO", cama: "223", tipo: "HOSPITALIZACION", estado: "HOSPITALIZADO", ingreso: [-2, 13, 20], medico: "SANDOVAL", dx: "Colecistitis aguda", cie10: "K81.0", cie9: "51.23", procedimiento: "Colecistectomía laparoscópica", asa: "II", honorario: { medico: "SANDOVAL", monto: 18000, servicio: "HON-CIR" } },
  { folio: "HOSP-2026-0425", paciente: "DELGADO", cama: "224", tipo: "HOSPITALIZACION", estado: "POSTOPERATORIO", ingreso: [0, 6, 30], medico: "IBARRA", dx: "Várices de miembros inferiores", cie10: "I83.9", cie9: "38.59", procedimiento: "Safenectomía", asa: "II", honorario: { medico: "IBARRA", monto: 15500, servicio: "HON-CIR" } },
  // Consulta externa de hoy: sin cama; lo que se surte de farmacia es VENTA (0 % IVA).
  { folio: "HOSP-2026-0426", paciente: "MONTES", cama: null, tipo: "CONSULTA", estado: "EN_VALORACION", ingreso: [0, 9, 30], medico: "LEDESMA", dx: "Control postoperatorio de hernioplastía", cie10: "Z09.0", cargos: [{ servicio: "CONS-EXT", cantidad: 1 }] },
];

/** Contenido mínimo del consentimiento (NOM-004 §10.1) según el procedimiento. */
function contenidoConsentimiento(tipo: "CONSENTIMIENTO_CIRUGIA" | "CONSENTIMIENTO_ANESTESIA" | "CONSENTIMIENTO_HOSPITALIZACION", procedimiento: string | null) {
  const acto = procedimiento ?? "el tratamiento indicado";
  if (tipo === "CONSENTIMIENTO_ANESTESIA") {
    return {
      establecimiento: "Hospital Haltus Hope",
      procedimiento: `Anestesia general balanceada para ${acto}`,
      riesgos: "Náusea y vómito postoperatorio, dolor faríngeo, reacción alérgica a fármacos, broncoaspiración, despertar intraoperatorio (raro), hipertermia maligna (muy raro).",
      beneficios: "Ausencia de dolor y de conciencia durante el procedimiento con monitoreo continuo.",
      alternativas: "Anestesia regional o sedación según el procedimiento; no realizar el procedimiento.",
      tipoAnestesia: "General balanceada",
      autorizaProcedimientosAdicionales: true,
    };
  }
  if (tipo === "CONSENTIMIENTO_HOSPITALIZACION") {
    return {
      establecimiento: "Hospital Haltus Hope",
      procedimiento: `Ingreso hospitalario para ${acto}`,
      riesgos: "Infección asociada a la atención, reacciones a medicamentos, caídas, complicaciones propias del padecimiento.",
      beneficios: "Vigilancia médica y de enfermería continua, tratamiento y estudios en el propio hospital.",
      alternativas: "Manejo ambulatorio o en otra unidad, cuando el padecimiento lo permita.",
      autorizaProcedimientosAdicionales: true,
    };
  }
  return {
    establecimiento: "Hospital Haltus Hope",
    procedimiento: acto,
    riesgos: "Sangrado, infección de la herida, lesión de estructuras vecinas, conversión a cirugía abierta, tromboembolia, complicaciones anestésicas.",
    beneficios: "Resolución del padecimiento con recuperación más rápida y menor dolor que la cirugía abierta.",
    alternativas: "Tratamiento médico conservador; cirugía abierta; no operarse, con los riesgos de la evolución natural.",
    consecuenciasDeNoAceptar: "Persistencia o agravamiento del padecimiento.",
    autorizaProcedimientosAdicionales: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function estadoCita(inicio: Date, fin: Date): "CONFIRMADA" | "EN_CURSO" | "TERMINADA" {
  if (fin.getTime() <= ahora.getTime()) return "TERMINADA";
  if (inicio.getTime() <= ahora.getTime()) return "EN_CURSO";
  return "CONFIRMADA";
}

function rawXmlStub(a: {
  emisor: { rfc: string; nombre: string };
  receptor: { rfc: string; nombre: string };
  uuid: string;
  fecha: Date;
  serie?: string;
  folio?: string;
  metodoPago: string;
  subtotal: number;
  iva: number;
  total: number;
  concepto: { claveProdServ: string; descripcion: string; exento: boolean };
}) {
  const f = a.fecha.toISOString().slice(0, 19);
  const m2 = (n: number) => n.toFixed(2);
  const traslado = a.concepto.exento
    ? `<cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${m2(a.subtotal)}" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>`
    : `<cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${m2(a.subtotal)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${m2(a.iva)}"/></cfdi:Traslados></cfdi:Impuestos>`;
  return (
    `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"` +
    (a.serie ? ` Serie="${a.serie}"` : "") +
    (a.folio ? ` Folio="${a.folio}"` : "") +
    ` Fecha="${f}" FormaPago="03" MetodoPago="${a.metodoPago}" Moneda="MXN" SubTotal="${m2(a.subtotal)}" Total="${m2(a.total)}" TipoDeComprobante="I" Exportacion="01" LugarExpedicion="72000">` +
    `<cfdi:Emisor Rfc="${a.emisor.rfc}" Nombre="${a.emisor.nombre}" RegimenFiscal="601"/>` +
    `<cfdi:Receptor Rfc="${a.receptor.rfc}" Nombre="${a.receptor.nombre}" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>` +
    `<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="${a.concepto.claveProdServ}" Cantidad="1" ClaveUnidad="E48" Descripcion="${a.concepto.descripcion}" ValorUnitario="${m2(a.subtotal)}" Importe="${m2(a.subtotal)}" ObjetoImp="02">${traslado}</cfdi:Concepto></cfdi:Conceptos>` +
    (a.concepto.exento ? "" : `<cfdi:Impuestos TotalImpuestosTrasladados="${m2(a.iva)}"><cfdi:Traslados><cfdi:Traslado Base="${m2(a.subtotal)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${m2(a.iva)}"/></cfdi:Traslados></cfdi:Impuestos>`) +
    `<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${a.uuid.toUpperCase()}" FechaTimbrado="${f}" RfcProvCertif="SAT970701NN3"/></cfdi:Complemento>` +
    `</cfdi:Comprobante>`
  );
}

async function main() {
  // Los episodios se codifican por catálogo: sin CIE-10 cargada no hay demo.
  const cie10 = await prisma.hospCatalogo.count({ where: { tipo: "CIE10", activo: true } });
  if (!cie10) {
    throw new Error("Los catálogos CIE no están cargados. Corre antes: ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/hospital-catalogos.ts");
  }

  const { companyId: cid, email } = await resolverEmpresa();
  const company = await prisma.company.findUniqueOrThrow({ where: { id: cid }, select: { rfc: true, razonSocial: true } });

  if (flag("--reset")) {
    console.log("· --reset: borrando las filas Hosp* de la empresa…");
    await borrarHospital(cid);
  }

  // ── Config (con la identidad sanitaria del establecimiento; no pisa lo ya capturado) ──
  await prisma.hospConfig.upsert({
    where: { companyId: cid },
    create: { companyId: cid, nombreHospital: "Haltus Hope", diasAlertaCaducidad: 90, topeAutorizacion: 60000, ivaServicios: 0.16, ivaMedicinasHospitalizacion: 0.16, ...ESTABLECIMIENTO },
    update: {},
  });
  await prisma.hospConfig.updateMany({ where: { companyId: cid, clues: null, licenciaSanitaria: null }, data: ESTABLECIMIENTO });

  // ── Directorio del hub: receptores fiscales, proveedores (médicos), empleado, banco ──
  const customerPorKey = new Map<string, { id: string; rfc: string; razonSocial: string }>();
  for (const p of PAGADORES) {
    if (p.rfc && p.razon) customerPorKey.set(p.key, await customer(cid, p.rfc, p.razon, { codigoPostal: p.cp ?? undefined }));
  }
  // «Receptor fiscal: su esposo» — la factura al paciente puede ir a otra persona.
  const esposoOrtega = await customer(cid, "SAMR840512QT7", "RODRIGO SALAZAR MENDOZA", { regimenFiscal: "605", codigoPostal: "72160" });

  const supplierPorKey = new Map<string, { id: string }>();
  for (const m of MEDICOS) {
    if (m.razon && m.clabe) {
      supplierPorKey.set(m.key, await supplier(cid, m.rfc, m.razon, m.clabe));
      await customer(cid, m.rfc, m.razon, { regimenFiscal: "612", codigoPostal: "72000" });
    }
  }

  let empleadoMant = await prisma.employee.findFirst({ where: { companyId: cid, rfc: "CARR820315LM9" }, select: { id: true, nombre: true, apellidoPaterno: true } });
  if (!empleadoMant) {
    empleadoMant = await prisma.employee.create({
      data: {
        companyId: cid, nombre: "Rubén", apellidoPaterno: "Castañeda", apellidoMaterno: "Ríos", puesto: "Jefe de mantenimiento", departamento: "Mantenimiento",
        rfc: "CARR820315LM9", curp: "CARR820315HPLSSB07", nss: "04058212345", codigoPostal: "72000",
        fechaIngreso: fechaLocal(2021, 3, 1), tipoContrato: "01", tipoJornada: "01", periodicidadPago: "04", salarioDiario: 612.4,
      },
      select: { id: true, nombre: true, apellidoPaterno: true },
    });
  }

  const CLABE_BANCO = "012180001122334455";
  let banco = await prisma.bankAccount.findFirst({ where: { companyId: cid, clabe: CLABE_BANCO }, select: { id: true } });
  if (!banco) {
    banco = await prisma.bankAccount.create({
      data: { companyId: cid, banco: "BBVA", nombre: "Operativa", numeroCuenta: "0111223344", clabe: CLABE_BANCO },
      select: { id: true },
    });
  }

  // ── Pagadores ──
  const pagadorPorKey = new Map<string, { id: string; nombre: string; tipo: string }>();
  for (const p of PAGADORES) {
    const existente = await prisma.hospPagador.findFirst({ where: { companyId: cid, nombre: p.nombre }, select: { id: true, nombre: true, tipo: true } });
    const row =
      existente ??
      (await prisma.hospPagador.create({
        data: {
          companyId: cid, nombre: p.nombre, tipo: p.tipo, tabulador: p.tabulador, customerId: customerPorKey.get(p.key)?.id ?? null,
          deducible: p.deducible, coaseguroPct: p.coaseguroPct, plazoDias: p.plazoDias, topeAutorizacion: p.topeAutorizacion,
          vigenciaInicio: p.vigenciaInicio, vigenciaFin: p.vigenciaFin,
          notas: p.key === "TEXTIL" ? "Convenio empresa: cubre el 100 % a sus empleados; renovación anual." : null,
        },
        select: { id: true, nombre: true, tipo: true },
      }));
    pagadorPorKey.set(p.key, row);
  }

  // ── Servicios y tarifas ──
  const servicioPorClave = new Map<string, { id: string; nombre: string; precioLista: number; ivaTasa: number | null; categoria: HospCargoCategoria }>();
  for (const s of SERVICIOS) {
    const row = await prisma.hospServicio.upsert({
      where: { companyId_clave: { companyId: cid, clave: s.clave } },
      create: { companyId: cid, clave: s.clave, nombre: s.nombre, categoria: s.categoria, unidad: s.unidad, precioLista: s.precioLista, ivaTasa: s.ivaTasa, claveProdServ: s.claveProdServ ?? null },
      update: {},
      select: { id: true, nombre: true, precioLista: true, ivaTasa: true, categoria: true },
    });
    servicioPorClave.set(s.clave, { ...row, precioLista: Number(row.precioLista), ivaTasa: row.ivaTasa == null ? null : Number(row.ivaTasa) });
    for (const [key, precio] of Object.entries(s.tarifas ?? {})) {
      const pagadorId = pagadorPorKey.get(key)!.id;
      await prisma.hospTarifa.upsert({
        where: { servicioId_pagadorId: { servicioId: row.id, pagadorId } },
        create: { servicioId: row.id, pagadorId, precio },
        update: {},
      });
    }
  }
  const srv = (clave: string) => {
    const s = servicioPorClave.get(clave);
    if (!s) throw new Error(`Servicio ${clave} no cargado`);
    return s;
  };

  // ── Recursos ──
  const recursoPorNombre = new Map<string, { id: string; nombre: string }>();
  for (const c of [...CAMAS.map((c) => ({ ...c, tipo: "CAMA" as HospRecursoTipo })), ...SALAS]) {
    const row = await prisma.hospRecurso.upsert({
      where: { companyId_tipo_nombre: { companyId: cid, tipo: c.tipo, nombre: c.nombre } },
      create: { companyId: cid, tipo: c.tipo, area: c.area, nombre: c.nombre, orden: c.orden, servicioId: c.servicio ? srv(c.servicio).id : null },
      update: {},
      select: { id: true, nombre: true },
    });
    recursoPorNombre.set(c.nombre, row);
  }
  const recurso = (nombre: string) => recursoPorNombre.get(nombre)!;

  // ── Médicos ──
  const medicoPorKey = new Map<string, { id: string; nombre: string }>();
  for (const m of MEDICOS) {
    const existente = await prisma.hospMedico.findFirst({ where: { companyId: cid, nombre: m.nombre }, select: { id: true, nombre: true } });
    const row =
      existente ??
      (await prisma.hospMedico.create({
        data: { companyId: cid, nombre: m.nombre, especialidad: m.especialidad, cedula: m.cedula, rfc: m.rfc, supplierId: supplierPorKey.get(m.key)?.id ?? null },
        select: { id: true, nombre: true },
      }));
    medicoPorKey.set(m.key, row);
  }
  const medico = (key: string) => medicoPorKey.get(key)!;

  // ── Farmacia: insumos, lotes y su entrada ──
  const insumoPorClave = new Map<string, { id: string; loteId: string }>();
  for (const i of INSUMOS) {
    // Grupo de control, sustancia, registro sanitario y cadena de frío son
    // atributos del catálogo: se mantienen al día también en los ya creados.
    const regulatorio = {
      controlado: i.controlado ?? false,
      grupoControl: i.grupoControl ?? null,
      sustanciaActiva: i.sustanciaActiva ?? null,
      registroSanitario: i.registroSanitario ?? null,
      requiereRefrigeracion: i.requiereRefrigeracion ?? false,
    };
    const insumo = await prisma.hospInsumo.upsert({
      where: { companyId_clave: { companyId: cid, clave: i.clave } },
      create: {
        companyId: cid, clave: i.clave, nombre: i.nombre, presentacion: i.presentacion, unidad: i.unidad, categoria: i.categoria,
        minimo: i.minimo, precioVenta: i.precioVenta, ultimoCosto: i.lote.costoUnitario, ivaTasa: i.ivaTasa, ...regulatorio,
      },
      update: regulatorio,
      select: { id: true },
    });
    const entrada = (i.lote.existencia + (APLICADO_ORTEGA[i.clave] ?? 0));
    const existenteLote = await prisma.hospLote.findUnique({ where: { insumoId_lote: { insumoId: insumo.id, lote: i.lote.lote } }, select: { id: true } });
    let loteId = existenteLote?.id;
    if (!loteId) {
      const lote = await prisma.hospLote.create({
        data: { companyId: cid, insumoId: insumo.id, lote: i.lote.lote, caducidad: i.lote.caducidad, existencia: entrada, costoUnitario: i.lote.costoUnitario, recibidoAt: dia(-20, 10, 0) },
        select: { id: true },
      });
      loteId = lote.id;
      await prisma.hospMovimientoInsumo.create({
        data: {
          companyId: cid, insumoId: insumo.id, loteId, tipo: "ENTRADA_COMPRA", cantidad: entrada, costoUnitario: i.lote.costoUnitario,
          fecha: dia(-20, 10, 0), referencia: `Recepción lote ${i.lote.lote}`, usuarioNombre: USUARIO_SEED,
        },
      });
    }
    insumoPorClave.set(i.clave, { id: insumo.id, loteId });
  }

  // ── Pacientes: identidad NOM-024 (CURP válida, entidad, domicilio), número
  // de expediente y aviso de privacidad (LFPDPPP). Los que ya existían sin
  // CURP o sin expediente (demo previa a P1) se completan.
  const pacientePorKey = new Map<string, { id: string }>();
  let expedientesAsignados = 0;
  for (const p of PACIENTES) {
    const curp = curpDe(p);
    const identidad = validarCurp(curp);
    const datosP1 = {
      curp,
      curpValidada: true,
      sinCurp: false,
      nacionalidad: "MEX",
      entidadNacimiento: identidad.entidad ?? null,
      calle: p.domicilio.calle,
      numeroExterior: p.domicilio.numeroExterior,
      numeroInterior: p.domicilio.numeroInterior ?? null,
      colonia: p.domicilio.colonia,
      municipio: p.domicilio.municipio,
      estado: p.domicilio.estado,
      codigoPostal: p.domicilio.codigoPostal,
      domicilio: `${p.domicilio.calle} ${p.domicilio.numeroExterior}${p.domicilio.numeroInterior ? ` int. ${p.domicilio.numeroInterior}` : ""}, ${p.domicilio.colonia}, ${p.domicilio.municipio}, ${p.domicilio.estado}, C.P. ${p.domicilio.codigoPostal}`,
      avisoPrivacidadVersion: p.aviso === false ? null : AVISO_VERSION,
      avisoPrivacidadAceptadoAt: p.aviso === false ? null : dia(-30, 10, 0),
    };
    const existente = await prisma.hospPaciente.findFirst({
      where: { companyId: cid, nombre: p.nombre, apellidoPaterno: p.apellidoPaterno, apellidoMaterno: p.apellidoMaterno },
      select: { id: true, curp: true, expedienteNumero: true },
    });
    let row: { id: string };
    if (existente) {
      row = existente;
      if (!existente.curp || !existente.expedienteNumero) {
        await prisma.$transaction(async (tx) => {
          const expedienteNumero = existente.expedienteNumero ?? (await siguienteFolio(tx, cid, "expediente", ahora));
          await tx.hospPaciente.update({ where: { id: existente.id }, data: { ...datosP1, expedienteNumero } });
        });
        expedientesAsignados++;
      }
    } else {
      row = await prisma.$transaction(async (tx) => {
        const expedienteNumero = await siguienteFolio(tx, cid, "expediente", ahora);
        return tx.hospPaciente.create({
          data: {
            companyId: cid, nombre: p.nombre, apellidoPaterno: p.apellidoPaterno, apellidoMaterno: p.apellidoMaterno, sexo: p.sexo,
            fechaNacimiento: fechaLocal(p.nacimiento[0], p.nacimiento[1], p.nacimiento[2], 12),
            telefono: p.telefono ?? null, tipoSangre: p.tipoSangre ?? null, alergias: p.alergias ?? null,
            pagadorId: pagadorPorKey.get(p.pagador)!.id,
            customerId: p.key === "ORTEGA" ? esposoOrtega.id : (customerPorKey.get(p.pagador)?.id ?? null),
            contactoEmergenciaNombre: p.key === "ORTEGA" ? "Rodrigo Salazar Mendoza" : null,
            contactoEmergenciaTelefono: p.key === "ORTEGA" ? "222 431 8891" : null,
            contactoEmergenciaParentesco: p.key === "ORTEGA" ? "Esposo" : null,
            expedienteNumero,
            ...datosP1,
          },
          select: { id: true },
        });
      });
      expedientesAsignados++;
    }
    pacientePorKey.set(p.key, row);
  }
  const paciente = (key: string) => pacientePorKey.get(key)!;
  const nombrePaciente = (key: string) => {
    const p = PACIENTES.find((x) => x.key === key)!;
    return `${p.nombre} ${p.apellidoPaterno} ${p.apellidoMaterno ?? ""}`.trim();
  };

  // ── Episodios ──
  const episodioPorFolio = new Map<string, { id: string; creado: boolean }>();
  const cargoHonorario = async (episodioId: string, medicoKey: string, monto: number, servicioClave: string, fecha: Date) =>
    prisma.hospCargo.create({
      data: {
        companyId: cid, episodioId, fecha, categoria: "HONORARIO", descripcion: `${medico(medicoKey).nombre} · ${srv(servicioClave).nombre.replace("Honorarios ", "").replace("de ", "")}`,
        cantidad: 1, precioUnitario: monto, ivaTasa: null, importe: monto, origen: "MANUAL", servicioId: srv(servicioClave).id, medicoId: medico(medicoKey).id,
      },
    });
  const cargoServicio = async (episodioId: string, clave: string, cantidad: number, fecha: Date, pagadorKey: string, origen: "MANUAL" | "EXPEDIENTE" = "MANUAL") => {
    const s = srv(clave);
    const tarifa = await prisma.hospTarifa.findUnique({ where: { servicioId_pagadorId: { servicioId: s.id, pagadorId: pagadorPorKey.get(pagadorKey)!.id } }, select: { precio: true } });
    const precio = Number(tarifa?.precio ?? s.precioLista);
    return prisma.hospCargo.create({
      data: { companyId: cid, episodioId, fecha, categoria: s.categoria, descripcion: s.nombre, cantidad, precioUnitario: precio, ivaTasa: s.ivaTasa, importe: r2(cantidad * precio), origen, servicioId: s.id },
    });
  };

  /**
   * Firma los consentimientos del episodio como lo exige la NOM-004 §10:
   * contenido mínimo, paciente que firma, dos testigos y el médico que
   * informó con su cédula (el cirujano en cirugía/ingreso, el anestesiólogo
   * en anestesia).
   */
  const firmarConsentimientos = async (episodioId: string, e: Ep, fecha: Date) => {
    const docs = await prisma.hospDocumento.findMany({
      where: { episodioId, tipo: { in: ["CONSENTIMIENTO_CIRUGIA", "CONSENTIMIENTO_ANESTESIA", "CONSENTIMIENTO_HOSPITALIZACION"] } },
      select: { id: true, tipo: true },
    });
    const cirujano = MEDICOS.find((m) => m.key === e.medico)!;
    const anestesiologo = MEDICOS.find((m) => m.key === "RENTERIA")!;
    for (const d of docs) {
      const tipo = d.tipo as "CONSENTIMIENTO_CIRUGIA" | "CONSENTIMIENTO_ANESTESIA" | "CONSENTIMIENTO_HOSPITALIZACION";
      const m = tipo === "CONSENTIMIENTO_ANESTESIA" ? anestesiologo : cirujano;
      await prisma.hospDocumento.update({
        where: { id: d.id },
        data: {
          estado: "FIRMADO",
          firmadoAt: fecha,
          contenido: contenidoConsentimiento(tipo, e.procedimiento ?? null),
          firmadoPor: nombrePaciente(e.paciente),
          firmadoParentesco: "Paciente",
          testigo1: e.paciente === "ORTEGA" ? "Rodrigo Salazar Mendoza" : "Enf. Paola Cruz",
          testigo2: "Enf. Laura Méndez",
          medicoNombre: m.nombre,
          medicoCedula: m.cedula,
        },
      });
    }
  };

  /** Nota de egreso (NOM-004 §8.10) firmada por el tratante, con las secciones mínimas. */
  const notaEgreso = async (episodioId: string, e: Ep, fechaAlta: Date) =>
    crearNota(prisma, {
      companyId: cid,
      episodioId,
      tipo: "EGRESO",
      fecha: fechaAlta,
      medicoId: medico(e.medico).id,
      usuario: { nombre: medico(e.medico).nombre },
      texto: `Egreso por ${e.alta!.motivo.toLowerCase()}. ${e.dx}${e.procedimiento ? ` · ${e.procedimiento}` : ""}.`,
      secciones: {
        diagnosticoEgreso: `${e.alta!.cie10 ?? e.cie10} ${e.dx}`,
        motivoEgreso: e.alta!.motivo,
        evolucion: e.procedimiento
          ? `Procedimiento sin complicaciones. Evolución postoperatoria satisfactoria: tolera vía oral, deambula, dolor controlado con analgesia oral.`
          : `Evolución satisfactoria con el tratamiento indicado; afebril, signos vitales normales.`,
        planManejo: "Analgésico oral cada 8 h por 3 días; dieta blanda 48 h; cuidados de herida con agua y jabón; reposo relativo; cita de control en 7 días. Acudir a urgencias ante fiebre, sangrado, dolor intenso o vómito persistente.",
        pronostico: "Bueno para la vida y la función.",
        ...(e.alta!.aldrete != null ? { aldrete: e.alta!.aldrete } : {}),
      },
    });

  for (const e of EPISODIOS) {
    const existente = await prisma.hospEpisodio.findUnique({ where: { companyId_folio: { companyId: cid, folio: e.folio } }, select: { id: true } });
    if (existente) {
      episodioPorFolio.set(e.folio, { id: existente.id, creado: false });
      continue;
    }
    const pac = PACIENTES.find((p) => p.key === e.paciente)!;
    const fechaIngreso = dia(...e.ingreso);
    const ep = await crearEpisodio(prisma, {
      companyId: cid,
      pacienteId: paciente(e.paciente).id,
      tipo: e.tipo,
      recursoId: e.cama ? recurso(e.cama).id : null,
      medicoId: medico(e.medico).id,
      diagnosticoCie10: e.cie10,
      diagnosticoIngresoCie10: e.cie10,
      procedimientoCie9: e.cie9 ?? null,
      triageNivel: e.triage ?? null,
      asa: e.asa ?? null,
      diagnostico: e.dx,
      procedimiento: e.procedimiento ?? null,
      motivo: e.motivo ?? null,
      fechaIngreso,
      folio: e.folio,
      usuario: { nombre: USUARIO_SEED },
    });
    episodioPorFolio.set(e.folio, { id: ep.id, creado: true });

    if (e.honorario) await cargoHonorario(ep.id, e.honorario.medico, e.honorario.monto, e.honorario.servicio, dia(e.ingreso[0], Math.min(e.ingreso[1] + 3, 23), 0));
    for (const c of e.cargos ?? []) await cargoServicio(ep.id, c.servicio, c.cantidad, dia(e.ingreso[0], Math.min(e.ingreso[1] + 1, 23), 0), pac.pagador);

    if (e.alta) {
      const fechaAlta = dia(...e.alta.fecha);
      // Las noches se cobran antes de soltar la cama (igual que la ruta de alta).
      await asegurarCargosEstancia(prisma, ep.id, fechaAlta);
      await firmarConsentimientos(ep.id, e, fechaIngreso);
      await notaEgreso(ep.id, e, fechaAlta);
      const seguimientoAt = e.alta.seguimiento ? dia(e.alta.fecha[0] + e.alta.seguimiento.dias, 10, 0) : null;
      await prisma.$transaction([
        prisma.hospEpisodio.update({
          where: { id: ep.id },
          data: {
            estado: "ALTA", fechaAlta, recursoId: null,
            motivoEgreso: e.alta.motivo, diagnosticoEgresoCie10: e.alta.cie10 ?? e.cie10, aldreteEgreso: e.alta.aldrete ?? null,
            seguimientoAt, seguimientoNota: e.alta.seguimiento?.nota ?? null,
          },
        }),
        ...(e.cama
          ? [
              prisma.hospRecurso.update({ where: { id: recurso(e.cama).id }, data: { estado: e.alta.camaDespues } }),
              prisma.hospTraslado.create({
                data: { episodioId: ep.id, fecha: fechaAlta, tipo: "ALTA", deRecursoId: recurso(e.cama).id, deRecursoNombre: e.cama, usuarioNombre: USUARIO_SEED },
              }),
            ]
          : []),
        prisma.hospDocumento.updateMany({ where: { episodioId: ep.id, estado: { not: "FIRMADO" } }, data: { estado: "FIRMADO", firmadoAt: fechaAlta } }),
      ]);
    } else {
      if (ep.estado !== e.estado) await prisma.hospEpisodio.update({ where: { id: ep.id }, data: { estado: e.estado } });
      // Identificación y póliza ya recibidas en admisión; consentimientos firmados si hubo cirugía.
      await prisma.hospDocumento.updateMany({ where: { episodioId: ep.id, tipo: { in: ["IDENTIFICACION", "POLIZA"] } }, data: { estado: "RECIBIDO" } });
      if (e.estado === "POSTOPERATORIO" || e.estado === "HOSPITALIZADO") await firmarConsentimientos(ep.id, e, fechaIngreso);
      await asegurarCargosEstancia(prisma, ep.id, ahora);
    }
  }

  // ── Hojas de urgencias (NOM-027): triage con hora y firma del médico ──
  const HOJAS_URGENCIAS: Array<{ folio: string; medico: string; texto: string; secciones: Record<string, unknown> }> = [
    {
      folio: "HOSP-2026-0422", medico: "FUENTES",
      texto: "Dolor y bloqueo de rodilla derecha tras torsión jugando futbol. Triage 3.",
      secciones: { triageNivel: 3, motivoAtencion: "Dolor y bloqueo articular de rodilla derecha tras mecanismo de torsión", signosVitales: "TA 128/82, FC 84, FR 17, T 36.5 °C, SpO₂ 97 %, dolor 6/10", resumenInterrogatorio: "Sin antecedentes de importancia; niega alergias.", exploracionFisica: "Derrame articular moderado, McMurray positivo, bloqueo en extensión.", diagnosticos: "S83.2 Desgarro de menisco medial", tratamiento: "Inmovilización, crioterapia, ketorolaco IM; radiografías y valoración por ortopedia.", pronostico: "Bueno; probable artroscopía.", destino: "Programar artroscopía de rodilla" },
    },
    {
      folio: "HOSP-2026-0417", medico: "FUENTES",
      texto: "Caída desde su altura con dolor e impotencia funcional de cadera derecha. Triage 2.",
      secciones: { triageNivel: 2, motivoAtencion: "Caída desde su altura con dolor e impotencia funcional de cadera derecha", signosVitales: "TA 146/88, FC 96, FR 20, T 36.7 °C, SpO₂ 95 %, dolor 8/10", resumenInterrogatorio: "Hipertenso en tratamiento; osteopenia conocida.", exploracionFisica: "Miembro pélvico derecho acortado y en rotación externa; pulsos distales presentes.", diagnosticos: "S72.0 Fractura del cuello de fémur", tratamiento: "Analgesia IV, tracción cutánea, protocolo prequirúrgico.", pronostico: "Reservado para la función.", destino: "Hospitalización y cirugía" },
    },
  ];
  for (const h of HOJAS_URGENCIAS) {
    const ep = episodioPorFolio.get(h.folio)!;
    if (!ep.creado) continue;
    const e = EPISODIOS.find((x) => x.folio === h.folio)!;
    await crearNota(prisma, {
      companyId: cid, episodioId: ep.id, tipo: "HOJA_URGENCIAS", fecha: dia(e.ingreso[0], e.ingreso[1], e.ingreso[2] + 10),
      medicoId: medico(h.medico).id, usuario: { nombre: medico(h.medico).nombre }, texto: h.texto, secciones: h.secciones,
    });
  }

  // ── Consulta externa de Montes: un ketorolaco VENDIDO (0 % IVA, criterio 9/IVA/N) ──
  const consultaMontes = episodioPorFolio.get("HOSP-2026-0426")!;
  if (consultaMontes.creado) {
    await aplicarInsumo(prisma, {
      companyId: cid, episodioId: consultaMontes.id, insumoId: insumoPorClave.get("MED-KETO30")!.id, cantidad: 1, fecha: dia(0, 9, 50),
      usuarioNombre: "Enf. Paola Cruz", medicoId: medico("LEDESMA").id, nota: "Se surte ketorolaco 30 mg IM en consulta.",
    });
  }

  // ── El expediente de María Fernanda Ortega (láminas 6, 8 y 17) ──
  const ortega = episodioPorFolio.get("HOSP-2026-0418")!;
  if (ortega.creado) {
    const epId = ortega.id;
    const ayer = (h: number, min: number) => dia(-1, h, min);

    await prisma.hospSignos.createMany({
      data: [
        { episodioId: epId, fecha: ayer(8, 30), taSistolica: 122, taDiastolica: 80, fc: 78, fr: 17, temperatura: 36.6, spo2: 97, peso: 62.5, talla: 1.64, dolor: 1, registradoPor: "Enf. Laura Méndez" },
        { episodioId: epId, fecha: ayer(13, 0), taSistolica: 116, taDiastolica: 74, fc: 80, fr: 16, temperatura: 36.8, spo2: 97, dolor: 4, registradoPor: "Enf. Laura Méndez" },
        { episodioId: epId, fecha: dia(0, 7, 0), taSistolica: 118, taDiastolica: 76, fc: 72, fr: 16, temperatura: 36.4, spo2: 98, dolor: 2, registradoPor: "Enf. Paola Cruz" },
      ],
    });

    // Notas con las secciones que pide la NOM-004 y la firma del sistema
    // (hash + sello): la historia clínica, la valoración preanestésica (ASA)
    // y la nota preoperatoria antes de entrar a quirófano.
    const nota = (tipo: HospNotaTipo, medicoKey: string, fecha: Date, texto: string, secciones: Record<string, unknown>, extra: { cargoId?: string } = {}) =>
      crearNota(prisma, { companyId: cid, episodioId: epId, tipo, fecha, medicoId: medico(medicoKey).id, usuario: { nombre: medico(medicoKey).nombre }, texto, secciones, cargoId: extra.cargoId });

    await nota("HISTORIA_CLINICA", "VEGA", ayer(7, 40), "Historia clínica de ingreso para colecistectomía laparoscópica programada.", {
      antecedentesHeredofamiliares: "Madre con diabetes tipo 2; padre hipertenso. Niega neoplasias.",
      antecedentesPersonalesPatologicos: "Sin cirugías previas. Niega alergias, transfusiones y enfermedades crónicas.",
      antecedentesPersonalesNoPatologicos: "Tabaquismo y alcoholismo negados. Esquema de vacunación completo. Actividad física 3 veces por semana.",
      antecedentesGinecoObstetricos: "G1 P1; FUM hace 12 días; método anticonceptivo: DIU.",
      padecimientoActual: "Cólico biliar de repetición de 4 meses de evolución, último episodio hace 10 días; ultrasonido con litiasis vesicular múltiple sin datos de colecistitis.",
      exploracionFisica: "Peso 62.5 kg, talla 1.64 m, IMC 23.2. Abdomen blando, Murphy negativo, sin visceromegalias. Resto sin alteraciones.",
      diagnosticos: "K80.2 Cálculo de la vesícula biliar sin colecistitis",
      pronostico: "Bueno para la vida y la función.",
      plan: "Colecistectomía laparoscópica programada; laboratorio preoperatorio; ayuno de 8 h; profilaxis antibiótica.",
    });
    await nota("PREANESTESICA", "RENTERIA", ayer(7, 55), "Valoración anestésica ASA I. Ayuno cumplido. Se autoriza procedimiento.", {
      evaluacionClinica: "Mallampati I, apertura oral adecuada, cuello móvil. Sin comorbilidades. Laboratorio preoperatorio normal.",
      asa: "I",
      tipoAnestesia: "General balanceada",
      planAnestesico: "Inducción con propofol y fentanilo, midazolam como coinductor; mantenimiento con sevoflurano; analgesia multimodal.",
      ayuno: "Sólidos 8 h, líquidos claros 2 h: cumplido.",
      medicacionPreanestesica: "Midazolam 2 mg IV en quirófano.",
    });
    await nota("PREOPERATORIA", "VEGA", ayer(8, 0), "Paciente en condiciones para cirugía. Se informa procedimiento y riesgos; consentimientos firmados.", {
      fechaCirugia: claveDia(ayer(8, 30)),
      diagnostico: "K80.2 Cálculo de la vesícula biliar sin colecistitis",
      planQuirurgico: "Colecistectomía laparoscópica (51.23) de cuatro puertos.",
      tipoIntervencion: "Electiva",
      riesgoQuirurgico: "Bajo (ASA I, Goldman I).",
      pronostico: "Bueno.",
      cuidadosPreoperatorios: "Ayuno, profilaxis antibiótica con cefalotina 1 g IV, medias de compresión.",
    });

    // Quirófano: el cargo nace del expediente (nota de procedimiento ligada).
    const quirofano = await prisma.hospCargo.create({
      data: {
        companyId: cid, episodioId: epId, fecha: ayer(8, 30), categoria: "QUIROFANO", descripcion: "Uso de quirófano 2", cantidad: 2.5, precioUnitario: 4800, ivaTasa: 0.16, importe: 12000,
        origen: "EXPEDIENTE", servicioId: srv("QX-HORA").id,
      },
    });
    await nota("PROCEDIMIENTO", "VEGA", ayer(11, 5), "Colecistectomía laparoscópica en Quirófano 2, 08:30–11:00 (2.5 h). Técnica de cuatro puertos, sin conversión. Pieza a histopatología.", {
      descripcion: "Colecistectomía laparoscópica de cuatro puertos (51.23).",
      hallazgos: "Vesícula con múltiples litos, sin colecistitis; vía biliar de calibre normal.",
      complicaciones: "Ninguna.",
    }, { cargoId: quirofano.id });

    // Farmacia: lo aplicado sale con su lote (kardex + cargo + nota en una
    // transacción). El midazolam (grupo III) sale amparado por receta y
    // prescriptor con cédula: así lo pide el libro de control.
    const aplicar = (clave: string, cantidad: number, fecha: Date, medicoKey: string, nota?: string, recetaRef?: string) =>
      aplicarInsumo(prisma, { companyId: cid, episodioId: epId, insumoId: insumoPorClave.get(clave)!.id, cantidad, fecha, usuarioNombre: "Enf. Laura Méndez", medicoId: medico(medicoKey).id, nota, recetaRef });
    await aplicar("MED-MIDA5", 1, ayer(8, 35), "RENTERIA", "Coinducción anestésica: midazolam 2 mg IV.", "RE-2026-00418");
    await aplicar("MED-PROPO200", 1, ayer(8, 40), "RENTERIA", "Inducción anestésica.");
    await aplicar("MED-CEFA1G", 6, ayer(9, 10), "VEGA", "Profilaxis antibiótica: 1 g IV cada 8 h por 48 h.");
    await aplicar("SOL-HART1000", 4, ayer(10, 15), "RENTERIA");
    // La excepción de la lámina 17: enfermería registró 2 pz más que nadie cargó.
    await crearNota(prisma, {
      companyId: cid, episodioId: epId, tipo: "MEDICAMENTO_APLICADO", fecha: ayer(16, 40), usuario: { nombre: "Enf. Laura Méndez" },
      texto: "Solución Hartmann 1000 ml · lote H-0455 · 2 pz — aplicación de piso registrada por enfermería, pendiente de cargar a la cuenta.",
      secciones: { medicamento: "Solución Hartmann 1000 ml", dosis: "2 pz", via: "IV", lote: "H-0455" },
    });

    await nota("POSTANESTESICA", "RENTERIA", ayer(11, 30), "Recuperación anestésica sin incidentes; Aldrete 9 al egreso de quirófano.", {
      tecnicaAnestesica: "General balanceada",
      medicamentos: "Midazolam 2 mg, fentanilo 150 µg, propofol 150 mg, rocuronio 40 mg, sevoflurano 2 %.",
      duracion: "2 h 30 min (08:30–11:00)",
      incidentes: "Ninguno.",
      liquidos: "Hartmann 1500 ml; sangrado 30 ml.",
      estadoEgresoQuirofano: "Despierta, orientada, ventilación espontánea, vía aérea libre, dolor 2/10.",
      aldrete: 9,
      plan: "Recuperación 2 h con monitoreo; analgesia con ketorolaco 30 mg IV cada 8 h.",
    });
    await nota("POSTOPERATORIA", "VEGA", ayer(11, 40), "Colecistectomía laparoscópica sin complicaciones. Sangrado mínimo. Paciente estable, pasa a recuperación.", {
      diagnosticoPreoperatorio: "K80.2 Cálculo de la vesícula biliar sin colecistitis",
      operacionPlaneada: "Colecistectomía laparoscópica",
      operacionRealizada: "Colecistectomía laparoscópica (51.23)",
      diagnosticoPostoperatorio: "K80.2 Litiasis vesicular; colecistitis crónica litiásica por histopatología pendiente",
      tecnica: "Neumoperitoneo con aguja de Veress, cuatro puertos, disección del triángulo de Calot, clipaje de arteria y conducto cístico, extracción en bolsa.",
      hallazgos: "Vesícula con múltiples litos, pared delgada, sin adherencias; vía biliar normal.",
      sangrado: "30 ml",
      conteoGasas: "Completo (10/10 gasas, 2/2 compresas).",
      incidentes: "Ninguno.",
      estadoPostquirurgico: "Estable, extubada, pasa a recuperación.",
      plan: "Analgesia multimodal, dieta líquida en 6 h, deambulación temprana; alta a las 24-48 h.",
      equipoQuirurgico: "Cirujano Dr. Alonso Vega; anestesióloga Dra. Claudia Rentería; instrumentista Enf. Paola Cruz; circulante Enf. Laura Méndez.",
      piezasPatologia: "Vesícula biliar a histopatología.",
    });
    await crearNota(prisma, {
      companyId: cid, episodioId: epId, tipo: "ENFERMERIA", fecha: ayer(20, 0), usuario: { nombre: "Enf. Laura Méndez" },
      texto: "Turno vespertino sin eventualidades.",
      secciones: {
        signosVitales: "TA 116/74, FC 80, FR 16, T 36.8 °C, SpO₂ 97 %, dolor 4/10 (13:00).",
        medicamentosMinistrados: "Cefalotina 1 g IV 09:10 y 17:10; ketorolaco 30 mg IV 12:00 y 20:00; Hartmann 1000 ml IV para 8 h.",
        procedimientos: "Curación de puertos; retiro de sonda vesical 14:00; primera deambulación 16:30.",
        observaciones: "Tolera líquidos, sin náusea. Herida limpia y seca.",
        dieta: "Líquidos claros desde las 17:00.",
      },
    });
    await nota("EVOLUCION", "VEGA", dia(0, 7, 30), "Tolera dieta líquida, deambula sin apoyo. Dolor 2/10. Herida limpia. Plan: alta mañana si continúa la evolución.", {
      subjetivo: "Refiere dolor leve en puertos (2/10), tolera líquidos, sin náusea.",
      objetivo: "TA 118/76, FC 72, FR 16, T 36.4 °C, SpO₂ 98 %. Abdomen blando, puertos limpios, peristalsis presente.",
      analisis: "Postoperatorio día 1 de colecistectomía laparoscópica con evolución favorable.",
      plan: "Dieta blanda, analgesia oral, retiro de venoclisis; alta mañana si continúa la evolución.",
    });

    // Recuperación, estudios y honorarios (láminas 8 y 18).
    await cargoServicio(epId, "REC-HORA", 2, ayer(11, 0), "GNP");
    await cargoServicio(epId, "EST-LABPRE", 1, ayer(7, 30), "GNP");
    await cargoServicio(epId, "EST-HISTO", 1, ayer(12, 0), "GNP");
    await cargoHonorario(epId, "VEGA", 18000, "HON-CIR", ayer(11, 40));
    await cargoHonorario(epId, "RENTERIA", 8500, "HON-ANES", ayer(11, 40));

    // La propuesta enseña la cuenta con las dos noches (13 y 14 ago): se
    // pre-corre el cron de mañana, que de todos modos ya no tendrá nada que hacer.
    await asegurarCargosEstancia(prisma, epId, dia(1, 0, 30));

    // Documentos: consentimientos firmados ayer (ya con contenido y firmantes,
    // ver firmarConsentimientos), identificación y póliza recibidas, nota de
    // egreso pendiente.
    await prisma.hospDocumento.updateMany({ where: { episodioId: epId, estado: "FIRMADO" }, data: { firmadoAt: ayer(7, 45) } });
    await prisma.hospDocumento.updateMany({ where: { episodioId: epId, tipo: { in: ["IDENTIFICACION", "POLIZA"] } }, data: { estado: "RECIBIDO" } });
    await prisma.hospEpisodio.update({ where: { id: epId }, data: { autorizacionPagador: "GNP-A-2026-118240", customerId: esposoOrtega.id } });
  }

  // ── Agenda de hoy (lámina 7) ──
  const CITAS = [
    { titulo: "Hernioplastía inguinal", recurso: "Quirófano 1", tipo: "CIRUGIA", inicio: [8, 0], fin: [10, 30], paciente: "PENA", medico: "SANDOVAL", episodio: "HOSP-2026-0411" },
    { titulo: "Colecistectomía laparoscópica", recurso: "Quirófano 2", tipo: "CIRUGIA", inicio: [8, 30], fin: [11, 0], paciente: "ORTEGA", medico: "VEGA", episodio: "HOSP-2026-0418" },
    { titulo: "Panendoscopía", recurso: "Endoscopía", tipo: "PROCEDIMIENTO", inicio: [9, 0], fin: [10, 0], paciente: "VILLALOBOS", medico: "RENTERIA", episodio: "HOSP-2026-0419" },
    { titulo: "Safenectomía", recurso: "Quirófano 1", tipo: "CIRUGIA", inicio: [12, 0], fin: [13, 30], paciente: "MARQUEZ", medico: "IBARRA", episodio: "HOSP-2026-0421" },
    { titulo: "Artroscopía de rodilla", recurso: "Quirófano 2", tipo: "CIRUGIA", inicio: [14, 0], fin: [15, 30], paciente: "AGUILAR", medico: "FUENTES", episodio: "HOSP-2026-0422" },
    { titulo: "Consulta externa", recurso: "Consultorio A", tipo: "CONSULTA", inicio: [12, 0], fin: [15, 30], paciente: null, medico: "LEDESMA", episodio: null, notas: "6 citas" },
  ] as const;
  let citasCreadas = 0;
  for (const c of CITAS) {
    const inicio = dia(0, c.inicio[0], c.inicio[1]);
    const fin = dia(0, c.fin[0], c.fin[1]);
    const existente = await prisma.hospCita.findFirst({ where: { companyId: cid, recursoId: recurso(c.recurso).id, inicio, titulo: c.titulo }, select: { id: true } });
    if (existente) continue;
    const pac = c.paciente ? PACIENTES.find((p) => p.key === c.paciente)! : null;
    await prisma.hospCita.create({
      data: {
        companyId: cid, recursoId: recurso(c.recurso).id, tipo: c.tipo, titulo: c.titulo, inicio, fin, estado: estadoCita(inicio, fin),
        pacienteId: pac ? paciente(pac.key).id : null,
        pacienteNombre: pac ? `${pac.nombre} ${pac.apellidoPaterno} ${pac.apellidoMaterno ?? ""}`.trim() : null,
        medicoId: medico(c.medico).id,
        episodioId: c.episodio ? episodioPorFolio.get(c.episodio)!.id : null,
        notas: "notas" in c ? c.notas : null,
      },
    });
    citasCreadas++;
  }

  // ── Cotizaciones (lámina 7) ──
  const COTIZACIONES = [
    { folio: "COT-2026-0311", paciente: "ORTEGA", pagador: "GNP", procedimiento: "Colecistectomía laparoscópica", estado: "ACEPTADA", creada: dia(-6, 11, 0), partidas: [{ servicio: "PROC-COLE", cantidad: 1 }, { descripcion: "Honorarios médicos (cirugía y anestesia)", categoria: "HONORARIO", precio: 26500, iva: null, cantidad: 1 }, { servicio: "PAQ-HOSP2", cantidad: 1 }] },
    { folio: "COT-2026-0312", paciente: "PENA", pagador: "AXA", procedimiento: "Hernioplastía inguinal", estado: "ENVIADA", creada: dia(-5, 16, 20), partidas: [{ servicio: "PROC-HERN", cantidad: 1 }, { descripcion: "Honorarios médicos (cirugía y anestesia)", categoria: "HONORARIO", precio: 17500, iva: null, cantidad: 1 }, { servicio: "HAB-STD", cantidad: 1 }] },
    { folio: "COT-2026-0313", paciente: "MARQUEZ", pagador: "TEXTIL", procedimiento: "Safenectomía", estado: "BORRADOR", creada: dia(-2, 9, 45), partidas: [{ servicio: "PROC-SAFE", cantidad: 1 }, { descripcion: "Honorarios médicos (cirugía y anestesia)", categoria: "HONORARIO", precio: 15500, iva: null, cantidad: 1 }, { servicio: "HAB-STD", cantidad: 1 }] },
  ] as const;
  for (const c of COTIZACIONES) {
    const existente = await prisma.hospCotizacion.findUnique({ where: { companyId_folio: { companyId: cid, folio: c.folio } }, select: { id: true } });
    if (existente) continue;
    const pac = PACIENTES.find((p) => p.key === c.paciente)!;
    const pagadorId = pagadorPorKey.get(c.pagador)!.id;
    const partidas = await Promise.all(
      c.partidas.map(async (p, i) => {
        if ("servicio" in p) {
          const s = srv(p.servicio);
          const tarifa = await prisma.hospTarifa.findUnique({ where: { servicioId_pagadorId: { servicioId: s.id, pagadorId } }, select: { precio: true } });
          const precio = Number(tarifa?.precio ?? s.precioLista);
          return { orden: i, servicioId: s.id, categoria: s.categoria, descripcion: s.nombre, cantidad: p.cantidad, precioUnitario: precio, ivaTasa: s.ivaTasa, importe: r2(p.cantidad * precio) };
        }
        return { orden: i, servicioId: null, categoria: p.categoria as HospCargoCategoria, descripcion: p.descripcion, cantidad: p.cantidad, precioUnitario: p.precio, ivaTasa: p.iva, importe: r2(p.cantidad * p.precio) };
      })
    );
    const subtotal = r2(partidas.reduce((s, p) => s + p.importe, 0));
    const iva = r2(partidas.reduce((s, p) => s + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));
    await prisma.hospCotizacion.create({
      data: {
        companyId: cid, folio: c.folio, pacienteId: paciente(pac.key).id, pacienteNombre: `${pac.nombre} ${pac.apellidoPaterno} ${pac.apellidoMaterno ?? ""}`.trim(),
        pagadorId, procedimiento: c.procedimiento, estado: c.estado, createdAt: c.creada, vigenciaHasta: dia(24, 23, 59),
        subtotal, iva, total: r2(subtotal + iva), partidas: { create: partidas },
      },
    });
  }

  // ── Mantenimiento ──
  const TICKETS = [
    { folio: "MANT-2026-0001", titulo: "Aire acondicionado de Quirófano 1 · preventivo", descripcion: "Mantenimiento preventivo semestral de la manejadora de aire. Cotización del proveedor: $12,900.00 (incluye filtros HEPA).", area: "QUIROFANO", equipo: "Manejadora de aire Q1", prioridad: "MEDIA", estado: "ASIGNADO", preventivo: true, programadoPara: dia(5, 10, 0), asignado: true, creado: dia(-3, 9, 0) },
    { folio: "MANT-2026-0002", titulo: "Cama 202 · limpieza terminal", descripcion: "Alta de N. E. Cifuentes a las 08:45. Limpieza terminal y cambio de colchón antes de liberar.", area: "HOSPITALIZACION", equipo: "Cama 202", prioridad: "ALTA", estado: "ABIERTO", preventivo: false, programadoPara: dia(0, 12, 0), asignado: false, creado: dia(0, 8, 50) },
    { folio: "MANT-2026-0003", titulo: "Autoclave central · falla de presión", descripcion: "No alcanza presión de esterilización en el ciclo de 134 °C. Se usa el autoclave de respaldo mientras tanto.", area: "QUIROFANO", equipo: "Autoclave central", prioridad: "URGENTE", estado: "EN_PROCESO", preventivo: false, programadoPara: null, asignado: true, creado: dia(-2, 14, 30) },
  ] as const;
  for (const t of TICKETS) {
    const existente = await prisma.hospTicket.findUnique({ where: { companyId_folio: { companyId: cid, folio: t.folio } }, select: { id: true } });
    if (existente) continue;
    await prisma.hospTicket.create({
      data: {
        companyId: cid, folio: t.folio, titulo: t.titulo, descripcion: t.descripcion, area: t.area, equipo: t.equipo, prioridad: t.prioridad, estado: t.estado,
        preventivo: t.preventivo, programadoPara: t.programadoPara, createdAt: t.creado, reportadoPor: t.folio === "MANT-2026-0002" ? "Enf. Paola Cruz" : "Dirección de operaciones",
        asignadoEmployeeId: t.asignado ? empleadoMant.id : null, asignadoA: t.asignado ? `${empleadoMant.nombre} ${empleadoMant.apellidoPaterno}` : null,
      },
    });
  }

  // ── CFDIs del hub: facturas de agosto cobradas y honorarios de los médicos ──
  // INGRESO al pagador de los episodios cerrados de agosto (PUE = cobrada).
  const factura = async (a: {
    tag: string; tipo: "INGRESO" | "EGRESO"; fecha: Date; serie: string; folio: string; metodoPago: "PUE" | "PPD";
    contraparte: { rfc: string; razon: string; customerId: string }; subtotal: number; iva: number; concepto: string; claveProdServ: string; exento: boolean;
  }) => {
    const uuid = uuidDemo(a.tag);
    const total = r2(a.subtotal + a.iva);
    const existente = await prisma.invoice.findUnique({ where: { companyId_uuid: { companyId: cid, uuid } }, select: { id: true } });
    if (existente) return existente;
    const emisor = a.tipo === "INGRESO" ? { rfc: company.rfc, nombre: company.razonSocial } : { rfc: a.contraparte.rfc, nombre: a.contraparte.razon };
    const receptor = a.tipo === "INGRESO" ? { rfc: a.contraparte.rfc, nombre: a.contraparte.razon } : { rfc: company.rfc, nombre: company.razonSocial };
    return prisma.invoice.create({
      data: {
        companyId: cid, customerId: a.contraparte.customerId, contraparteRfc: a.contraparte.rfc, contraparteNombre: a.contraparte.razon,
        tipo: a.tipo, status: "STAMPED", tipoSat: "I", uuid, serie: a.serie, folio: a.folio, fecha: a.fecha,
        formaPago: "03", metodoPago: a.metodoPago, usoCfdi: "G03", subtotal: a.subtotal, total, totalImpuestos: a.iva, origenModulo: "HOSPITAL",
        rawXml: rawXmlStub({ emisor, receptor, uuid, fecha: a.fecha, serie: a.serie, folio: a.folio, metodoPago: a.metodoPago, subtotal: a.subtotal, iva: a.iva, total, concepto: { claveProdServ: a.claveProdServ, descripcion: a.concepto, exento: a.exento } }),
        items: { create: { cantidad: 1, claveProdServ: a.claveProdServ, claveUnidad: "E48", descripcion: a.concepto, valorUnitario: a.subtotal, importe: a.subtotal } },
        ...(a.exento ? {} : { taxes: { create: { tipo: "IVA", factor: "TASA", tasa: 0.16, base: a.subtotal, importe: a.iva } } }),
      },
      select: { id: true },
    });
  };
  const pagoBanco = async (tag: string, invoiceId: string, fecha: Date, monto: number, sentido: "CREDITO" | "DEBITO", contraparte: { rfc: string; razon: string }) => {
    const referencia = `HALTUS-${tag}`;
    let mov = await prisma.bankTransaction.findFirst({ where: { companyId: cid, referencia }, select: { id: true } });
    if (!mov) {
      mov = await prisma.bankTransaction.create({
        data: {
          companyId: cid, bankAccountId: banco!.id, fecha, referencia, tipo: sentido, monto: sentido === "CREDITO" ? monto : -monto, status: "MATCHED", invoiceId,
          descripcion: `SPEI ${sentido === "CREDITO" ? "RECIBIDO" : "ENVIADO"} ${contraparte.razon.slice(0, 24)} ${tag}`, contraparteNombre: contraparte.razon, contraparteRfc: contraparte.rfc,
        },
        select: { id: true },
      });
    }
    const det = await prisma.conciliacionDetalle.findUnique({ where: { bankTransactionId_invoiceId: { bankTransactionId: mov.id, invoiceId } }, select: { id: true } });
    if (!det) await prisma.conciliacionDetalle.create({ data: { bankTransactionId: mov.id, invoiceId, montoAsignado: monto } });
  };

  // Facturas a los pagadores de los dos episodios de agosto y liga de sus cargos.
  for (const [folioEp, pagadorKey, serieFolio, tag] of [
    ["HOSP-2026-0392", "AXA", "1162", "ing-0392"],
    ["HOSP-2026-0401", "TEXTIL", "1171", "ing-0401"],
  ] as const) {
    const ep = episodioPorFolio.get(folioEp)!;
    const cargos = await prisma.hospCargo.findMany({ where: { episodioId: ep.id, cancelado: false }, select: { id: true, importe: true, ivaTasa: true, fecha: true } });
    const subtotal = r2(cargos.reduce((s, c) => s + Number(c.importe), 0));
    const iva = r2(cargos.reduce((s, c) => s + (c.ivaTasa == null ? 0 : r2(Number(c.importe) * Number(c.ivaTasa))), 0));
    const contraparte = customerPorKey.get(pagadorKey)!;
    const fecha = new Date(Math.max(...cargos.map((c) => c.fecha.getTime())) + 26 * 3_600_000);
    const inv = await factura({ tag, tipo: "INGRESO", fecha, serie: "A", folio: serieFolio, metodoPago: "PUE", contraparte: { rfc: contraparte.rfc, razon: contraparte.razonSocial, customerId: contraparte.id }, subtotal, iva, concepto: `Servicios hospitalarios · episodio ${folioEp}`, claveProdServ: "85101601", exento: false });
    await prisma.hospCargo.updateMany({ where: { episodioId: ep.id, invoiceId: null }, data: { invoiceId: inv.id } });
    await pagoBanco(tag, inv.id, new Date(fecha.getTime() + 3 * 86_400_000), r2(subtotal + iva), "CREDITO", { rfc: contraparte.rfc, razon: contraparte.razonSocial });
  }

  // Facturas de honorarios que los médicos emiten al hospital (EGRESO): dos ya dispersadas, dos recibidas.
  const honorariosCfdi = [
    { medico: "SANDOVAL", tag: "egr-sandoval-ago", fecha: dia(-22, 17, 0), folio: "218", monto: 24000, pagado: dia(-20, 11, 0), concepto: "Honorarios médicos · hernioplastía inguinal HOSP-2026-0392" },
    { medico: "IBARRA", tag: "egr-ibarra-ago", fecha: dia(-14, 12, 0), folio: "77", monto: 15500, pagado: dia(-12, 11, 0), concepto: "Honorarios médicos · safenectomía HOSP-2026-0401" },
    { medico: "VEGA", tag: "egr-vega-sep", fecha: dia(-1, 18, 30), folio: "402", monto: 18000, pagado: null, concepto: "Honorarios médicos · colecistectomía laparoscópica HOSP-2026-0418" },
    { medico: "RENTERIA", tag: "egr-renteria-sep", fecha: dia(-1, 19, 0), folio: "151", monto: 8500, pagado: null, concepto: "Honorarios de anestesiología · HOSP-2026-0418" },
  ] as const;
  for (const h of honorariosCfdi) {
    const m = MEDICOS.find((x) => x.key === h.medico)!;
    const contraparte = await prisma.customer.findUniqueOrThrow({ where: { companyId_rfc: { companyId: cid, rfc: m.rfc } }, select: { id: true, rfc: true, razonSocial: true } });
    const inv = await factura({ tag: h.tag, tipo: "EGRESO", fecha: h.fecha, serie: "H", folio: h.folio, metodoPago: h.pagado ? "PUE" : "PPD", contraparte: { rfc: contraparte.rfc, razon: contraparte.razonSocial, customerId: contraparte.id }, subtotal: h.monto, iva: 0, concepto: h.concepto, claveProdServ: "85121600", exento: true });
    if (h.pagado) await pagoBanco(h.tag, inv.id, h.pagado, h.monto, "DEBITO", { rfc: contraparte.rfc, razon: contraparte.razonSocial });
  }

  // ── Resumen ──
  const [camas, ocupadas, episodiosActivos, pacientes, insumos, lotes, citas, cotizaciones, tickets, cargosOrtega, notasSelladas, controlados, consentimientos] = await Promise.all([
    prisma.hospRecurso.count({ where: { companyId: cid, tipo: "CAMA", activo: true } }),
    prisma.hospEpisodio.count({ where: { companyId: cid, recursoId: { not: null }, estado: { notIn: ["ALTA", "CANCELADO"] }, recurso: { tipo: "CAMA" } } }),
    prisma.hospEpisodio.count({ where: { companyId: cid, estado: { notIn: ["ALTA", "CANCELADO"] } } }),
    prisma.hospPaciente.count({ where: { companyId: cid } }),
    prisma.hospInsumo.count({ where: { companyId: cid } }),
    prisma.hospLote.count({ where: { companyId: cid } }),
    prisma.hospCita.count({ where: { companyId: cid, inicio: { gte: dia(0), lt: dia(1) } } }),
    prisma.hospCotizacion.count({ where: { companyId: cid } }),
    prisma.hospTicket.count({ where: { companyId: cid } }),
    prisma.hospCargo.findMany({ where: { episodioId: ortega.id, cancelado: false }, select: { importe: true, ivaTasa: true } }),
    prisma.hospNota.count({ where: { episodio: { companyId: cid }, hash: { not: null } } }),
    prisma.hospInsumo.count({ where: { companyId: cid, grupoControl: { in: ["I", "II", "III"] } } }),
    prisma.hospDocumento.count({ where: { companyId: cid, estado: "FIRMADO", medicoCedula: { not: null }, tipo: { in: ["CONSENTIMIENTO_CIRUGIA", "CONSENTIMIENTO_ANESTESIA", "CONSENTIMIENTO_TRANSFUSION", "CONSENTIMIENTO_HOSPITALIZACION"] } } }),
  ]);
  const subtotalOrtega = r2(cargosOrtega.reduce((s, c) => s + Number(c.importe), 0));
  const ivaOrtega = r2(cargosOrtega.reduce((s, c) => s + (c.ivaTasa == null ? 0 : r2(Number(c.importe) * Number(c.ivaTasa))), 0));

  console.log(`
✔ HOSPITAL demo lista: ${company.razonSocial} (${company.rfc}) · companyId ${cid}
  · Censo: ${ocupadas} / ${camas} camas ocupadas · ${episodiosActivos} episodios activos · ${pacientes} pacientes
  · Expediente HOSP-2026-0418 (M. F. Ortega): ${cargosOrtega.length} cargos · subtotal $${subtotalOrtega.toLocaleString("es-MX", { minimumFractionDigits: 2 })} · IVA $${ivaOrtega.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
  · Farmacia: ${insumos} insumos (${controlados} controlados I-III con libro) · ${lotes} lotes (Propofol caduca en 31 días, Ketorolaco en 54)
  · Agenda de hoy: ${citas} citas (${citasCreadas} nuevas) · ${cotizaciones} cotizaciones · ${tickets} tickets
  · P1 normativa: ${expedientesAsignados} expedientes asignados/completados · ${notasSelladas} notas con firma del sistema · ${consentimientos} consentimientos con contenido NOM-004
    CLUES ${ESTABLECIMIENTO.clues} · ${ESTABLECIMIENTO.licenciaSanitaria} · responsable ${ESTABLECIMIENTO.responsableSanitario} · aviso de privacidad v${AVISO_VERSION}
${email ? `  Entra como ${email} y selecciona la empresa.` : ""}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
