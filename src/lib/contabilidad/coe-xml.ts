// ─────────────────────────────────────────────────────────────────────────────
// SAT Contabilidad Electrónica — XML generators
//
// Genera los dos XMLs mensuales que SAT requiere para PMs:
//   1. Catálogo de Cuentas (COE_Cat_1_3.xsd)  → una vez al año + cuando cambia
//   2. Balanza de Comprobación (COE_Bal_1_3.xsd) → cada mes
//
// Referencia: Anexo 24 de la Resolución Miscelánea Fiscal
//   http://omawww.sat.gob.mx/fichas_tematicas/buzon_tributario/Paginas/contabilidad_electronica.aspx
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { balanza } from "./posting";

const VERSION_CAT = "1.3";
const VERSION_BAL = "1.3";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function money(n: number): string {
  return n.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Catálogo de Cuentas
// ─────────────────────────────────────────────────────────────────────────────
//
// <catalogocuentas:Catalogo ...>
//   <catalogocuentas:Ctas CodAgrup="101" NumCta="101" Desc="Caja" Nivel="1" Natur="D" />
//   ...
// </catalogocuentas:Catalogo>
//
// - CodAgrup: código agrupador SAT (100, 101, 102.01, etc.)
// - NumCta:   nuestro código interno (usamos el mismo)
// - Desc:     descripción
// - Nivel:    1, 2, 3
// - Natur:    D (deudora) o A (acreedora)
//   Activo + Gasto + Costo = D
//   Pasivo + Capital + Ingreso = A

function naturaleza(tipo: string): "D" | "A" {
  return ["ACTIVO", "GASTO", "COSTO"].includes(tipo) ? "D" : "A";
}

export type CoeCatXmlOptions = {
  companyId: string;
  year: number;
  month: number;
};

export async function generateCatalogoXml(opts: CoeCatXmlOptions): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: opts.companyId },
    select: { rfc: true },
  });
  if (!company) throw new Error("Empresa no encontrada");

  const accounts = await prisma.chartAccount.findMany({
    where: { companyId: opts.companyId, isActive: true },
    orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
  });

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" ` +
    `Version="${VERSION_CAT}" ` +
    `RFC="${esc(company.rfc)}" ` +
    `Mes="${String(opts.month).padStart(2, "0")}" ` +
    `Anio="${opts.year}">`
  );

  for (const a of accounts) {
    const codAgrup = a.subcuenta ?? a.cuentaSAT;
    const numCta = a.subcuenta ?? a.cuentaSAT;
    lines.push(
      `  <catalogocuentas:Ctas ` +
      `CodAgrup="${esc(codAgrup)}" ` +
      `NumCta="${esc(numCta)}" ` +
      `Desc="${esc(a.nombre)}" ` +
      `Nivel="${a.nivel}" ` +
      `Natur="${naturaleza(a.tipo)}" />`
    );
  }

  lines.push(`</catalogocuentas:Catalogo>`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Balanza de Comprobación
// ─────────────────────────────────────────────────────────────────────────────
//
// <BCE:Balanza ...>
//   <BCE:Ctas NumCta="101" SaldoIni="0" Debe="0" Haber="0" SaldoFin="0" />
//   ...
// </BCE:Balanza>
//
// TipoEnvio:
//   N = Normal
//   C = Complementaria
// En v1 emitimos siempre "N".
// SaldoIni = saldo al inicio del periodo (mes)
// SaldoFin = saldo al final del periodo
//
// NOTA: En v1 no tenemos saldos iniciales por cuenta acumulados de meses
// anteriores. Emitimos el XML con SaldoIni=0 para cuentas sin actividad
// previa. Una vez que tengamos "cierre anual" podremos acarrear saldos.

export type CoeBalXmlOptions = {
  companyId: string;
  year: number;
  month: number;
  tipoEnvio?: "N" | "C";
};

export async function generateBalanzaXml(opts: CoeBalXmlOptions): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: opts.companyId },
    select: { rfc: true },
  });
  if (!company) throw new Error("Empresa no encontrada");

  const rows = await balanza(opts.companyId, opts.year, opts.month);

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd" ` +
    `Version="${VERSION_BAL}" ` +
    `RFC="${esc(company.rfc)}" ` +
    `Mes="${String(opts.month).padStart(2, "0")}" ` +
    `Anio="${opts.year}" ` +
    `TipoEnvio="${opts.tipoEnvio ?? "N"}">`
  );

  for (const r of rows) {
    // Skip accounts with no activity AND no balance
    if (Math.abs(r.cargos) < 0.01 && Math.abs(r.abonos) < 0.01 && Math.abs(r.saldo) < 0.01) {
      continue;
    }
    const numCta = r.subcuenta ?? r.cuentaSAT;
    const saldoIni = 0; // v1: no opening balance carryover
    const debe = r.cargos;
    const haber = r.abonos;
    const saldoFin = r.saldo;
    lines.push(
      `  <BCE:Ctas ` +
      `NumCta="${esc(numCta)}" ` +
      `SaldoIni="${money(saldoIni)}" ` +
      `Debe="${money(debe)}" ` +
      `Haber="${money(haber)}" ` +
      `SaldoFin="${money(saldoFin)}" />`
    );
  }

  lines.push(`</BCE:Balanza>`);
  return lines.join("\n");
}
