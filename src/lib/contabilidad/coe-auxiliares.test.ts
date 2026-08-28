import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAuxiliarCtasXml, renderAuxiliarFoliosXml } from "./coe-auxiliares";

const xsdDir = join(dirname(fileURLToPath(import.meta.url)), "xsd");
function hasXmllint(): boolean {
  try { execFileSync("xmllint", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function validate(xml: string, xsd: string): { ok: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "aux-"));
  const p = join(dir, "doc.xml");
  writeFileSync(p, xml, "utf8");
  try {
    execFileSync("xmllint", ["--noout", "--schema", join(xsdDir, xsd), p], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: Buffer }).stderr) : String(e);
    return { ok: false, err };
  }
}

const RUN = hasXmllint();
const d = RUN ? describe : describe.skip;

d("Auxiliar de Cuentas → AuxiliarCtas_1_3.xsd", () => {
  it("valida con saldos y detalle de movimientos", () => {
    const xml = renderAuxiliarCtasXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      tipoSolicitud: "DE",
      numTramite: "AB123456789012",
      cuentas: [
        {
          numCta: "102.01", desCta: "Bancos", saldoIni: 1000, saldoFin: 1200,
          movimientos: [
            { fecha: "2026-05-10", numUnIdenPol: "1", concepto: "Cobro", debe: 300, haber: 0 },
            { fecha: "2026-05-20", numUnIdenPol: "2", concepto: "Pago", debe: 0, haber: 100 },
          ],
        },
      ],
    });
    const r = validate(xml, "AuxiliarCtas_1_3.xsd");
    expect(r.ok, r.err).toBe(true);
  });

  it("una cuenta con saldo pero SIN movimientos se omite (el XSD exige ≥1 DetalleAux)", () => {
    const xml = renderAuxiliarCtasXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 7,
      tipoSolicitud: "AF",
      numOrden: "ABC1234567/26",
      cuentas: [
        {
          numCta: "102.01", desCta: "Bancos", saldoIni: 1000, saldoFin: 1200,
          movimientos: [{ fecha: "2026-07-10", numUnIdenPol: "1", concepto: "Cobro", debe: 200, haber: 0 }],
        },
        { numCta: "601.58", desCta: "Otros impuestos y derechos", saldoIni: 62465, saldoFin: 62465, movimientos: [] },
      ],
    });
    expect(xml).not.toContain("601.58");
    const r = validate(xml, "AuxiliarCtas_1_3.xsd");
    expect(r.ok, r.err).toBe(true);
  });
});

d("Auxiliar de Folios → AuxiliarFolios_1_3.xsd", () => {
  it("valida con CompNal por póliza", () => {
    const xml = renderAuxiliarFoliosXml({
      rfc: "AAA010101AAA",
      year: 2026,
      month: 5,
      tipoSolicitud: "AF",
      numOrden: "ABC1234567/26",
      detalles: [
        {
          numUnIdenPol: "1",
          fecha: "2026-05-10",
          comprobantes: [{ uuid: "11111111-1111-1111-1111-111111111111", rfc: "XAXX010101000", montoTotal: 116 }],
        },
      ],
    });
    expect(xml).toContain("RepAuxFol:DetAuxFol");
    const r = validate(xml, "AuxiliarFolios_1_3.xsd");
    expect(r.ok, r.err).toBe(true);
  });
});
