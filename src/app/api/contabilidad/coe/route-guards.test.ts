import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = ["catalogo", "balanza", "polizas", "aux-cuentas", "aux-folios"] as const;
const GENERADOR = {
  catalogo: "generateCatalogoXml",
  balanza: "generateBalanzaXml",
  polizas: "generatePolizasXmlDetallado",
  "aux-cuentas": "generateAuxiliarCtasXml",
  "aux-folios": "generateAuxiliarFoliosXml",
} as const;

describe("rutas individuales de Contabilidad Electrónica", () => {
  it.each(ROUTES)("%s aplica la compuerta canónica antes de generar", (route) => {
    const source = readFileSync(
      join(process.cwd(), "src", "app", "api", "contabilidad", "coe", route, "route.ts"),
      "utf8"
    );
    expect(source).toContain('from "@/lib/cierre/compuerta-entregables"');
    expect(source).toMatch(/await evaluarCompuertaEntregable\(companyId, year, month\)/);
    expect(source.indexOf("await evaluarCompuertaEntregable")).toBeLessThan(
      source.indexOf(`await ${GENERADOR[route]}`)
    );
  });
});
