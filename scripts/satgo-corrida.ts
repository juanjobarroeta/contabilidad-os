/**
 * Corrida de cumplimiento vía SatGo para las empresas «Syntage» (e.firma
 * guardada, tier con Syntage y pago vigente — el mismo criterio que el
 * aprovisionamiento). Por empresa: opinión 32-D, CSF y acuses de declaraciones
 * del periodo. Todo se guarda en la base (ComplianceSnapshot con el PDF,
 * TaxDeclaration con el acuse); es exactamente lo que el cron hará cada mes.
 *
 * Uso (con el entorno de producción):
 *   DATABASE_URL=… CREDENTIALS_ENCRYPTION_KEY=… SATGO_API_KEY=… ANTHROPIC_API_KEY=… \
 *     npx tsx scripts/satgo-corrida.ts --ejercicio 2026 --mes 8 [--solo oc,csf,dec] \
 *     [--rfc CBA170606FQ8,ZIO190321JI6] [--guardar /ruta] [--paralelo 2] [--dry]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../src/lib/prisma";
import { nivelPagoEmpresas } from "../src/lib/billing/pagadores";
import { planIncluyeSyntage } from "../src/lib/planes";
import { persistComplianceResult } from "../src/lib/fiscal/cumplimiento/persist";
import { SatGoClient, SatGoError } from "../src/lib/fiscal/cumplimiento/satgo/client";
import { SatGoComplianceProvider } from "../src/lib/fiscal/cumplimiento/satgo/provider";
import { importarDeclaracionesSatGo } from "../src/lib/fiscal/cumplimiento/satgo/declaraciones";

function arg(nombre: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (nombre: string) => process.argv.includes(`--${nombre}`);

const EJERCICIO = Number(arg("ejercicio", String(new Date().getFullYear())));
const MES = Number(arg("mes", "0"));
const SOLO = new Set((arg("solo", "oc,csf,dec") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const RFCS = (arg("rfc") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const GUARDAR = arg("guardar");
const PARALELO = Math.max(1, Number(arg("paralelo", "2")));
const DRY = flag("dry");

function guardar(rfc: string, nombre: string, bytes: Uint8Array | Buffer) {
  if (!GUARDAR) return;
  const dir = path.join(GUARDAR, rfc);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nombre), bytes);
}

type Linea = { rfc: string; razon: string; oc: string; csf: string; dec: string; ms: number };

async function empresa(c: { id: string; rfc: string; razonSocial: string }, provider: SatGoComplianceProvider, client: SatGoClient): Promise<Linea> {
  const t0 = Date.now();
  const linea: Linea = { rfc: c.rfc, razon: c.razonSocial.slice(0, 26), oc: "-", csf: "-", dec: "-", ms: 0 };
  const err = (e: unknown) => (e instanceof SatGoError ? `${e.transitorio ? "transitorio " : ""}${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 110);

  if (SOLO.has("oc")) {
    try {
      const r = await provider.fetchSatOpinion(c.id);
      if (r.acusePdf) guardar(c.rfc, r.acusePdfNombre ?? "opinion-32d.pdf", r.acusePdf);
      const p = await persistComplianceResult(c.id, r);
      linea.oc = `${r.resultado}${p.changed ? " NUEVO" : p.pdfGuardado ? " +pdf" : " ="}${p.hallazgos ? ` h${p.hallazgos}` : ""}`;
    } catch (e) { linea.oc = `ERR ${err(e)}`; }
  }
  if (SOLO.has("csf")) {
    try {
      const r = await provider.fetchCsf(c.id);
      if (r.acusePdf) guardar(c.rfc, r.acusePdfNombre ?? "csf.pdf", r.acusePdf);
      const p = await persistComplianceResult(c.id, r);
      linea.csf = `${r.perfil.estatusPadron} reg=${r.perfil.regimenes.join("/") || "?"} obl=${r.perfil.obligaciones.length}${p.changed ? " NUEVO" : p.pdfGuardado ? " +pdf" : " ="}${p.hallazgos ? ` h${p.hallazgos}` : ""}`;
    } catch (e) { linea.csf = `ERR ${err(e)}`; }
  }
  if (SOLO.has("dec")) {
    try {
      const r = await importarDeclaracionesSatGo(c.id, { ejercicio: EJERCICIO, mes: MES }, { client, onArchivo: (n, b) => guardar(c.rfc, n, b) });
      linea.dec = r.estado === "error" ? `ERR ${r.error?.slice(0, 110)}`
        : `${r.estado} arch=${r.archivos} parse=${r.acusesParseados} creadas=${r.creadas} marc=${r.marcadores} pdf+=${r.pdfAdjuntados}${r.omitidos.length ? ` omit=${r.omitidos.map((o) => `${o.archivo}:${o.motivo}`).join(";").slice(0, 120)}` : ""}${r.estado === "sin_archivo" && r.error ? ` (${r.error.slice(0, 80)})` : ""}`;
    } catch (e) { linea.dec = `ERR ${err(e)}`; }
  }
  linea.ms = Date.now() - t0;
  return linea;
}

async function main() {
  const todas = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null }, fielKey: { not: null }, fielPassword: { not: null },
      ...(RFCS.length ? { rfc: { in: RFCS } } : {}),
    },
    select: { id: true, rfc: true, razonSocial: true, tier: true },
    orderBy: { razonSocial: "asc" },
  });
  const niveles = await nivelPagoEmpresas(todas.map((c) => c.id));
  const elegidas = todas.filter((c) => RFCS.length || (planIncluyeSyntage(c.tier) && niveles.get(c.id) !== "NINGUNO"));
  const fuera = todas.filter((c) => !elegidas.includes(c));

  console.log(`SatGo corrida ${EJERCICIO}-${MES || "todo"} · pasos=${[...SOLO].join(",")} · empresas=${elegidas.length}${fuera.length ? ` (fuera: ${fuera.map((c) => `${c.rfc} ${c.tier}/${niveles.get(c.id)}`).join(", ")})` : ""}`);
  if (DRY) {
    for (const c of elegidas) console.log(`  ${c.rfc}\t${c.tier}\t${niveles.get(c.id)}\t${c.razonSocial}`);
    await prisma.$disconnect();
    return;
  }

  const client = new SatGoClient();
  const provider = new SatGoComplianceProvider(async (id) => {
    const c = await prisma.company.findUnique({ where: { id }, select: { rfc: true } });
    if (!c?.rfc) throw new Error("La empresa no tiene RFC");
    return c.rfc;
  }, client);

  const cola = [...elegidas];
  const lineas: Linea[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    for (let c = cola.shift(); c; c = cola.shift()) {
      const l = await empresa(c, provider, client);
      lineas.push(l);
      console.log(`${l.rfc}\t${l.razon.padEnd(26)}\t${Math.round(l.ms / 1000)}s\n   32-D: ${l.oc}\n   CSF:  ${l.csf}\n   dec:  ${l.dec}`);
    }
  }));

  const errores = lineas.filter((l) => /^ERR/.test(l.oc) || /^ERR/.test(l.csf) || /^ERR/.test(l.dec)).length;
  console.log(`\n${lineas.length} empresas en ${Math.round((Date.now() - t0) / 1000)}s · con errores: ${errores}`);
  await prisma.$disconnect();
  process.exit(errores ? 1 : 0);
}

main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
