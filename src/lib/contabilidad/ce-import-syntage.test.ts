import { describe, it, expect } from "vitest";
import { refsXmlDe, esDocumentoCe } from "./ce-import-syntage";

// Formas REALES de un registro de Contabilidad Electrónica de Syntage
// (AUTOMOTRIZ MARGOM, 2023-12). Los cuatro archivos son: acuse de recibo (PDF),
// acuse de procesamiento (PDF), el documento del SAT (XML) y el sello digital
// —que TAMBIÉN es XML—. Los dos XML comparten RFC y namespace de ContabilidadE:
// por eso la selección se hace por contenido y no por nombre ni por orden.

const BALANZA_XML = `<?xml version="1.0" encoding="utf-8"?>
<BCE:Balanza xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" Version="1.3" RFC="AMA170817NK1" Mes="12" Anio="2023" TipoEnvio="N">
  <BCE:Ctas NumCta="101" SaldoIni="178806.18" Debe="0.00" Haber="104930.69" SaldoFin="73875.49"/>
  <BCE:Ctas NumCta="115.04" SaldoIni="63212282.46" Debe="61331823.15" Haber="69435357.83" SaldoFin="55108747.78"/>
</BCE:Balanza>`;

const SELLO_XML = `<?xml version="1.0" encoding="utf-8"?>
<SelloDigitalContElec xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="www.sat.gob.mx/esquemas/ContabilidadE/1_1/SelloDigitalContElec" Version="1.1" Folio="000223120000000037042" RFC="AMA170817NK1" FechadeSello="2024-01-23T16:53:46.7608158" sello="" noCertificadoSAT="00001088888800000037" selloSAT="nj03koYAU66bHhvI7OcCZ6EXSsX/i+ErnXpddrpr6FCr3bbb3D4i8Gjr8bMF4SIitpPsX9pHAupc5/jKX0waJtcD21E4Dta9Xf0lIJ/I+VGFmYT+ML9MYa8a2TUezKxVdN0gzmlhqQWEQvv0OmIZ/F"/>`;

const CATALOGO_XML = `<?xml version="1.0" encoding="utf-8"?>
<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" Version="1.3" RFC="AMA170817NK1" Mes="12" Anio="2023">
  <catalogocuentas:Ctas CodAgrup="101.01" NumCta="101.01" Desc="Caja" Nivel="2" Natur="D"/>
</catalogocuentas:Catalogo>`;

const registro = (files: Record<string, unknown>[]) => ({ year: 2023, month: 12, fileType: "B", files });

const ACUSE_RECIBO = { "@id": "/files/ack-receipt", filename: "acuse_recibo.pdf", mimeType: "application/pdf" };
const ACUSE_PROC = { "@id": "/files/ack-processing", filename: "acuse_procesamiento.pdf", mimeType: "application/pdf" };
const DOC = { "@id": "/files/doc", filename: "AMA170817NK1202312BN.xml", mimeType: "text/xml" };
const SELLO = { "@id": "/files/stamp", filename: "AMA170817NK1202312BN_sello.xml", mimeType: "text/xml" };

describe("refsXmlDe() — descarta los acuses PDF", () => {
  it("deja fuera los dos acuses y conserva los dos XML", () => {
    const refs = refsXmlDe(registro([ACUSE_RECIBO, ACUSE_PROC, DOC, SELLO]));
    expect(refs.map((r) => r.ref)).toEqual(["/files/doc", "/files/stamp"]);
  });

  it("conserva el nombre para poder verlo en los logs", () => {
    const [primero] = refsXmlDe(registro([DOC]));
    expect(primero.nombre).toBe("AMA170817NK1202312BN.xml");
  });

  it("un archivo sin ref utilizable no entra a la lista", () => {
    expect(refsXmlDe(registro([{ filename: "suelto.xml", mimeType: "text/xml" }]))).toEqual([]);
  });

  it("acepta `id` cuando no viene `@id`", () => {
    const refs = refsXmlDe(registro([{ id: "abc", filename: "x.xml", mimeType: "text/xml" }]));
    expect(refs).toEqual([{ ref: "abc", nombre: "x.xml" }]);
  });

  it("sin archivos devuelve lista vacía", () => {
    expect(refsXmlDe({ files: [] })).toEqual([]);
    expect(refsXmlDe({})).toEqual([]);
  });
});

describe("esDocumentoCe() — el sello digital no pasa por balanza", () => {
  it("la balanza real es documento B", () => {
    expect(esDocumentoCe(BALANZA_XML, "B")).toBe(true);
  });

  // El corazón del bug: el sello es XML, trae el MISMO RFC y el mismo
  // namespace de ContabilidadE. Sólo su raíz lo delata.
  it("el sello digital NO es la balanza, aunque comparta RFC y namespace", () => {
    expect(SELLO_XML).toContain("AMA170817NK1");
    expect(SELLO_XML).toContain("ContabilidadE");
    expect(esDocumentoCe(SELLO_XML, "B")).toBe(false);
  });

  it("el catálogo real es documento CT y no se confunde con la balanza", () => {
    expect(esDocumentoCe(CATALOGO_XML, "CT")).toBe(true);
    expect(esDocumentoCe(CATALOGO_XML, "B")).toBe(false);
    expect(esDocumentoCe(BALANZA_XML, "CT")).toBe(false);
  });

  it("el sello tampoco pasa por catálogo", () => {
    expect(esDocumentoCe(SELLO_XML, "CT")).toBe(false);
  });
});
