// ─────────────────────────────────────────────────────────────────────────────
// SAT Contabilidad Electrónica — XML generators (Anexo 24, v1.3)
//
//   1. Catálogo de Cuentas (CatalogoCuentas_1_3.xsd)   → al año / cuando cambia
//   2. Balanza de Comprobación (BalanzaComprobacion_1_3.xsd) → cada mes
//
// Las funciones `render*` son PURAS (sin DB) para poder validarlas contra los
// XSD del SAT en pruebas (ver coe-xml.test.ts). Las `generate*` leen de la base
// y delegan en las puras.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { balanza } from "./posting";
import { naturalezaPorTipo } from "./coe-saldos";
import { hashBalanza, decidirEnvio } from "./coe-envio";

const VERSION = "1.3";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const money = (n: number): string => n.toFixed(2);
const mm = (month: number): string => String(month).padStart(2, "0");

// ── 1. Catálogo de Cuentas ───────────────────────────────────────────────────

export interface CatalogoCuentaInput {
  codAgrup: string; // código agrupador SAT (100, 101, 102.01…)
  numCta: string; // código interno
  desc: string;
  nivel: number;
  natur: "D" | "A";
}

/** Render puro del Catálogo de Cuentas. */
export function renderCatalogoXml(args: {
  rfc: string;
  year: number;
  month: number;
  cuentas: CatalogoCuentaInput[];
}): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" ` +
      `Version="${VERSION}" RFC="${esc(args.rfc)}" Mes="${mm(args.month)}" Anio="${args.year}">`,
  ];
  for (const c of args.cuentas) {
    lines.push(
      `  <catalogocuentas:Ctas CodAgrup="${esc(c.codAgrup)}" NumCta="${esc(c.numCta)}" ` +
        `Desc="${esc(c.desc)}" Nivel="${c.nivel}" Natur="${c.natur}" />`,
    );
  }
  lines.push(`</catalogocuentas:Catalogo>`);
  return lines.join("\n");
}

export type CoeCatXmlOptions = { companyId: string; year: number; month: number };

export async function generateCatalogoXml(opts: CoeCatXmlOptions): Promise<string> {
  const company = await prisma.company.findUnique({ where: { id: opts.companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");

  const accounts = await prisma.chartAccount.findMany({
    where: { companyId: opts.companyId, isActive: true },
    orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
  });

  return renderCatalogoXml({
    rfc: company.rfc,
    year: opts.year,
    month: opts.month,
    cuentas: accounts.map((a) => {
      const code = a.subcuenta ?? a.cuentaSAT;
      return {
        codAgrup: code,
        numCta: code,
        desc: a.nombre,
        nivel: a.nivel,
        natur: ((a.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(a.tipo)),
      };
    }),
  });
}

// ── 2. Balanza de Comprobación ───────────────────────────────────────────────
//
// SaldoIni/SaldoFin son acumulados (arrastre incluido) y se emiten como MAGNITUD
// no negativa — la naturaleza (CodAgrup) implica el signo. TipoEnvio: N normal,
// C complementaria (en C, FechaModBal es obligatoria — pendiente, hoy N-only).

export interface BalanzaCuentaInput {
  numCta: string;
  cargos: number;
  abonos: number;
  saldoInicial: number; // con signo; se emite |valor|
  saldoFinal: number; // con signo; se emite |valor|
}

/** Render puro de la Balanza de Comprobación. Omite cuentas sin movimiento ni saldo. */
export function renderBalanzaXml(args: {
  rfc: string;
  year: number;
  month: number;
  tipoEnvio?: "N" | "C";
  /** Obligatoria (Anexo 24) cuando TipoEnvio = "C". Formato YYYY-MM-DD. */
  fechaModBal?: string | null;
  cuentas: BalanzaCuentaInput[];
}): string {
  const tipoEnvio = args.tipoEnvio ?? "N";
  // FechaModBal sólo aplica (y es obligatoria) en complementarias.
  const fechaModBalAttr =
    tipoEnvio === "C" && args.fechaModBal ? ` FechaModBal="${esc(args.fechaModBal)}"` : "";
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd" ` +
      `Version="${VERSION}" RFC="${esc(args.rfc)}" Mes="${mm(args.month)}" Anio="${args.year}" TipoEnvio="${tipoEnvio}"${fechaModBalAttr}>`,
  ];
  for (const c of args.cuentas) {
    if (
      Math.abs(c.cargos) < 0.01 && Math.abs(c.abonos) < 0.01 &&
      Math.abs(c.saldoInicial) < 0.01 && Math.abs(c.saldoFinal) < 0.01
    ) {
      continue; // sin movimiento ni saldo → se omite
    }
    lines.push(
      `  <BCE:Ctas NumCta="${esc(c.numCta)}" ` +
        `SaldoIni="${money(Math.abs(c.saldoInicial))}" ` +
        `Debe="${money(c.cargos)}" Haber="${money(c.abonos)}" ` +
        `SaldoFin="${money(Math.abs(c.saldoFinal))}" />`,
    );
  }
  lines.push(`</BCE:Balanza>`);
  return lines.join("\n");
}

export type CoeBalXmlOptions = {
  companyId: string;
  year: number;
  month: number;
  /** Override manual; si se omite, se decide N/C automáticamente vs el último envío. */
  tipoEnvio?: "N" | "C";
  fechaModBal?: string | null;
};

export interface BalanzaXmlResult {
  xml: string;
  tipoEnvio: "N" | "C";
  fechaModBal: string | null;
}

export async function generateBalanzaXml(opts: CoeBalXmlOptions): Promise<BalanzaXmlResult> {
  const company = await prisma.company.findUnique({ where: { id: opts.companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");

  const rows = await balanza(opts.companyId, opts.year, opts.month);
  const cuentas = rows.map((r) => ({
    numCta: r.subcuenta ?? r.cuentaSAT,
    cargos: r.cargos,
    abonos: r.abonos,
    saldoInicial: r.saldoInicial,
    saldoFinal: r.saldoFinal,
  }));

  const periodo = `${opts.year}-${mm(opts.month)}`;
  const nuevoHash = hashBalanza(cuentas);
  const hoy = new Date().toISOString().slice(0, 10);

  const previo = await prisma.coeEnvio.findUnique({
    where: { companyId_tipoDoc_periodo: { companyId: opts.companyId, tipoDoc: "BALANZA", periodo } },
  });

  // Override manual del contador, o decisión automática N/C contra el último envío.
  const decision = opts.tipoEnvio
    ? { tipoEnvio: opts.tipoEnvio, fechaModBal: opts.tipoEnvio === "C" ? (opts.fechaModBal ?? hoy) : null }
    : decidirEnvio(
        previo ? { contenidoHash: previo.contenidoHash, tipoEnvio: previo.tipoEnvio, fechaModBal: previo.fechaModBal } : null,
        nuevoHash,
        hoy,
      );

  const xml = renderBalanzaXml({
    rfc: company.rfc,
    year: opts.year,
    month: opts.month,
    tipoEnvio: decision.tipoEnvio,
    fechaModBal: decision.fechaModBal,
    cuentas,
  });

  await prisma.coeEnvio.upsert({
    where: { companyId_tipoDoc_periodo: { companyId: opts.companyId, tipoDoc: "BALANZA", periodo } },
    create: { companyId: opts.companyId, tipoDoc: "BALANZA", periodo, contenidoHash: nuevoHash, tipoEnvio: decision.tipoEnvio, fechaModBal: decision.fechaModBal },
    update: { contenidoHash: nuevoHash, tipoEnvio: decision.tipoEnvio, fechaModBal: decision.fechaModBal },
  });

  return { xml, tipoEnvio: decision.tipoEnvio, fechaModBal: decision.fechaModBal };
}
