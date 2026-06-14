import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCatalogoXml, renderBalanzaXml } from "./coe-xml";

const xsdDir = join(dirname(fileURLToPath(import.meta.url)), "xsd");

function hasXmllint(): boolean {
  try {
    execFileSync("xmllint", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Valida un XML contra un XSD vendado con xmllint. Devuelve {ok, err}. */
function validate(xml: string, xsd: string): { ok: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "coe-"));
  const xmlPath = join(dir, "doc.xml");
  writeFileSync(xmlPath, xml, "utf8");
  try {
    execFileSync("xmllint", ["--noout", "--schema", join(xsdDir, xsd), xmlPath], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: Buffer }).stderr) : String(e);
    return { ok: false, err };
  }
}

const RUN = hasXmllint();
const d = RUN ? describe : describe.skip;
if (!RUN) console.warn("[coe-xml.test] xmllint no disponible — se omite la validación XSD");

d("Catálogo de Cuentas → CatalogoCuentas_1_3.xsd", () => {
  it("valida contra el XSD del SAT", () => {
    const xml = renderCatalogoXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      cuentas: [
        { codAgrup: "102", numCta: "102", desc: "Bancos", nivel: 1, natur: "D" },
        { codAgrup: "102.01", numCta: "102.01", desc: "Bancos nacionales", nivel: 2, natur: "D" },
        { codAgrup: "201.01", numCta: "201.01", desc: "Proveedores nacionales", nivel: 2, natur: "A" },
      ],
    });
    const r = validate(xml, "CatalogoCuentas_1_3.xsd");
    expect(r.ok, r.err).toBe(true);
  });
});

d("Balanza de Comprobación → BalanzaComprobacion_1_3.xsd", () => {
  it("valida con saldos de arrastre y magnitudes no negativas", () => {
    const xml = renderBalanzaXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      tipoEnvio: "N",
      cuentas: [
        // deudora con arrastre + movimiento
        { numCta: "102.01", cargos: 300, abonos: 100, saldoInicial: 1000, saldoFinal: 1200 },
        // acreedora con saldo negativo en signo → debe emitirse como magnitud
        { numCta: "201.01", cargos: 300, abonos: 800, saldoInicial: -2000, saldoFinal: -2500 },
        // sin movimiento ni saldo → se omite (no rompe el XML)
        { numCta: "107.01", cargos: 0, abonos: 0, saldoInicial: 0, saldoFinal: 0 },
      ],
    });
    expect(xml).toContain(`SaldoFin="2500.00"`); // |−2500|, no negativo
    expect(xml).not.toContain("107.01"); // omitida
    const r = validate(xml, "BalanzaComprobacion_1_3.xsd");
    expect(r.ok, r.err).toBe(true);
  });

  it("el validador SÍ detecta XML inválido (RFC vacío)", () => {
    const xml = renderBalanzaXml({
      rfc: "", // RFC vacío → viola el patrón del XSD
      year: 2026,
      month: 5,
      cuentas: [{ numCta: "102.01", cargos: 1, abonos: 0, saldoInicial: 0, saldoFinal: 1 }],
    });
    expect(validate(xml, "BalanzaComprobacion_1_3.xsd").ok).toBe(false);
  });
});
