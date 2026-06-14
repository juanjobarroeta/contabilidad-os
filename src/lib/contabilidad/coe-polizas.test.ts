import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPolizasXml, agruparPolizas, type EntryForPoliza } from "./coe-polizas";

const xsdDir = join(dirname(fileURLToPath(import.meta.url)), "xsd");
function hasXmllint(): boolean {
  try { execFileSync("xmllint", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function validate(xml: string): { ok: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "polz-"));
  const p = join(dir, "doc.xml");
  writeFileSync(p, xml, "utf8");
  try {
    execFileSync("xmllint", ["--noout", "--schema", join(xsdDir, "PolizasPeriodo_1_3.xsd"), p], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: Buffer }).stderr) : String(e);
    return { ok: false, err };
  }
}

describe("agruparPolizas", () => {
  it("agrupa por documento (referencia) y numera consecutivo", () => {
    const entries: EntryForPoliza[] = [
      { numCta: "105.01", desCta: "Clientes", concepto: "Venta", tipo: "CARGO", monto: 116, fecha: "2026-05-10", referencia: "uuid-1", referenciaTipo: "CFDI", fuente: "CFDI" },
      { numCta: "401.01", desCta: "Ventas", concepto: "Venta", tipo: "ABONO", monto: 100, fecha: "2026-05-10", referencia: "uuid-1", referenciaTipo: "CFDI", fuente: "CFDI" },
      { numCta: "208.01", desCta: "IVA trasladado", concepto: "Venta", tipo: "ABONO", monto: 16, fecha: "2026-05-10", referencia: "uuid-1", referenciaTipo: "CFDI", fuente: "CFDI" },
      { numCta: "601.84", desCta: "Sueldos", concepto: "Nómina", tipo: "CARGO", monto: 5000, fecha: "2026-05-15", referencia: "NOM-1", referenciaTipo: "NOMINA", fuente: "NOMINA" },
      { numCta: "102.01", desCta: "Bancos", concepto: "Nómina", tipo: "ABONO", monto: 5000, fecha: "2026-05-15", referencia: "NOM-1", referenciaTipo: "NOMINA", fuente: "NOMINA" },
    ];
    const polizas = agruparPolizas(entries);
    expect(polizas).toHaveLength(2);
    expect(polizas[0].numUnIdenPol).toBe("1");
    expect(polizas[0].transacciones).toHaveLength(3); // la venta
    expect(polizas[1].transacciones).toHaveLength(2); // la nómina
    // Debe/Haber repartidos por tipo
    const venta = polizas[0].transacciones.find((t) => t.numCta === "105.01")!;
    expect(venta).toMatchObject({ debe: 116, haber: 0 });
  });
});

const RUN = hasXmllint();
(RUN ? describe : describe.skip)("renderPolizasXml → PolizasPeriodo_1_3.xsd", () => {
  it("valida con CompNal (devolución, NumTramite)", () => {
    const xml = renderPolizasXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      tipoSolicitud: "DE",
      numTramite: "AB123456789012",
      polizas: agruparPolizas([
        { numCta: "105.01", desCta: "Clientes", concepto: "Venta", tipo: "CARGO", monto: 116, fecha: "2026-05-10", referencia: "u1", referenciaTipo: "CFDI", fuente: "CFDI", compNal: { uuid: "11111111-1111-1111-1111-111111111111", rfc: "XAXX010101000", montoTotal: 116 } },
        { numCta: "401.01", desCta: "Ventas", concepto: "Venta", tipo: "ABONO", monto: 116, fecha: "2026-05-10", referencia: "u1", referenciaTipo: "CFDI", fuente: "CFDI" },
      ]),
    });
    expect(xml).toContain("UUID_CFDI=");
    const r = validate(xml);
    expect(r.ok, r.err).toBe(true);
  });

  it("valida auditoría (NumOrden) sin CompNal", () => {
    const xml = renderPolizasXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      tipoSolicitud: "AF",
      numOrden: "ABC1234567/26",
      polizas: agruparPolizas([
        { numCta: "601.84", desCta: "Sueldos", concepto: "Nómina", tipo: "CARGO", monto: 5000, fecha: "2026-05-15", referencia: null, referenciaTipo: null, fuente: "NOMINA" },
        { numCta: "102.01", desCta: "Bancos", concepto: "Nómina", tipo: "ABONO", monto: 5000, fecha: "2026-05-15", referencia: null, referenciaTipo: null, fuente: "NOMINA" },
      ]),
    });
    const r = validate(xml);
    expect(r.ok, r.err).toBe(true);
  });
});
