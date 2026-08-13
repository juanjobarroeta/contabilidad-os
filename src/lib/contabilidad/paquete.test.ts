import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { toXlsx } from "@/lib/export/xlsx";
import { hojaBalanza } from "./reportes-xlsx";
import {
  campoFolio,
  nombreArchivoSat,
  nombreZip,
  renderManifiesto,
  type ResumenPaquete,
} from "./paquete";

const resumen = (over: Partial<ResumenPaquete> = {}): ResumenPaquete => ({
  rfc: "TEGM961219BW1",
  razonSocial: "MERCEDES TRESPALACIOS GONZALEZ",
  year: 2025,
  month: 7,
  posteado: true,
  readiness: "lista",
  archivos: [{ ruta: "01-XML SAT/TEGM961219BW1202507B N.XML", descripcion: "Balanza." }],
  omitidos: [],
  generadoEn: "2026-08-13 17:20",
  ...over,
});

describe("campoFolio", () => {
  it("AF y FC usan NumOrden; DE y CO usan NumTramite", () => {
    // Si se cruzan, el XML sale con el atributo equivocado y el SAT lo rechaza.
    expect(campoFolio("AF")).toBe("numOrden");
    expect(campoFolio("FC")).toBe("numOrden");
    expect(campoFolio("DE")).toBe("numTramite");
    expect(campoFolio("CO")).toBe("numTramite");
  });
});

describe("nombreArchivoSat", () => {
  it("sigue la convención RFC + año + mes + clave", () => {
    expect(nombreArchivoSat("TEGM961219BW1", 2025, 7, "B", "N")).toBe("TEGM961219BW1202507BN.XML");
    expect(nombreArchivoSat("TEGM961219BW1", 2025, 7, "CT")).toBe("TEGM961219BW1202507CT.XML");
  });

  it("rellena el mes a dos dígitos", () => {
    // Sin el cero el SAT no reconoce el periodo.
    expect(nombreArchivoSat("AAA010101AAA", 2025, 3, "B", "N")).toContain("202503");
  });
});

describe("nombreZip", () => {
  it("lleva RFC y periodo: termina en la carpeta del cliente", () => {
    expect(nombreZip("TEGM961219BW1", 2025, 7)).toBe("Paquete contable TEGM961219BW1 2025-07.zip");
  });
});

describe("renderManifiesto", () => {
  it("identifica empresa, RFC y periodo", () => {
    const txt = renderManifiesto(resumen());
    expect(txt).toContain("TEGM961219BW1");
    expect(txt).toContain("MERCEDES TRESPALACIOS GONZALEZ");
    expect(txt).toContain("2025-07");
    expect(txt).toContain("JULIO 2025");
  });

  it("dice si las cifras son definitivas o preliminares", () => {
    // Es la diferencia entre poder mandarlo al SAT y no poder.
    expect(renderManifiesto(resumen({ posteado: true }))).toMatch(/POSTEADO/);
    const sinPostear = renderManifiesto(resumen({ posteado: false }));
    expect(sinPostear).toMatch(/SIN POSTEAR/);
    expect(sinPostear).toMatch(/PRELIMINARES/);
  });

  it("refleja el semáforo de contabilidad electrónica", () => {
    expect(renderManifiesto(resumen({ readiness: "lista" }))).toMatch(/LISTA/);
    expect(renderManifiesto(resumen({ readiness: "con_huecos" }))).toMatch(/CON HUECOS/);
    expect(renderManifiesto(resumen({ readiness: "incompleta" }))).toMatch(/INCOMPLETA/);
  });

  it("lista cada archivo con su descripción", () => {
    const txt = renderManifiesto(
      resumen({
        archivos: [
          { ruta: "01-XML SAT/a.XML", descripcion: "Catálogo de cuentas." },
          { ruta: "02-Estados financieros/b.xlsx", descripcion: "Balanza y estados." },
        ],
      })
    );
    expect(txt).toContain("01-XML SAT/a.XML");
    expect(txt).toContain("Catálogo de cuentas.");
    expect(txt).toContain("02-Estados financieros/b.xlsx");
  });

  it("DECLARA lo que no se incluyó: un hueco silencioso es peor", () => {
    const txt = renderManifiesto(
      resumen({ omitidos: ["DIOT: no hubo operaciones con terceros pagadas en el mes."] })
    );
    expect(txt).toContain("NO INCLUIDO");
    expect(txt).toContain("no hubo operaciones con terceros");
  });

  it("sin omisiones no imprime la sección vacía", () => {
    expect(renderManifiesto(resumen({ omitidos: [] }))).not.toContain("NO INCLUIDO");
  });

  it("aclara que el paquete NO se envía solo", () => {
    // Que nadie crea que descargarlo ya cumplió la obligación.
    expect(renderManifiesto(resumen())).toMatch(/no se envía solo/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Armado del zip. La ruta mezcla texto (XML, manifiesto) con binario (xlsx) en
// el mismo archivo; si el binario se guarda como texto, el Excel sale corrupto
// y no hay forma de notarlo mirando el zip. Aquí se arma igual que en la ruta y
// se vuelve a abrir.
// ─────────────────────────────────────────────────────────────────────────────

describe("zip del paquete", () => {
  async function armar() {
    const zip = new JSZip();
    zip.file("01-XML SAT/BAL.XML", "<?xml version=\"1.0\"?><Balanza/>");
    zip.file(
      "02-Estados financieros/Estados 2025-07.xlsx",
      new Uint8Array(
        toXlsx([
          hojaBalanza([
            {
              cuentaSAT: "102", subcuenta: "102.01", nombre: "Bancos", tipo: "ACTIVO", nivel: 3,
              cargos: 1500.5, abonos: 0, saldo: 1500.5, saldoInicial: 0, saldoFinal: 1500.5,
            },
          ]),
        ])
      )
    );
    zip.file("LEEME.txt", renderManifiesto(resumen()));
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return JSZip.loadAsync(buf);
  }

  it("conserva las tres piezas con su ruta", async () => {
    const leido = await armar();
    expect(Object.keys(leido.files).sort()).toEqual(
      expect.arrayContaining([
        "01-XML SAT/BAL.XML",
        "02-Estados financieros/Estados 2025-07.xlsx",
        "LEEME.txt",
      ])
    );
  });

  it("el XML y el manifiesto siguen legibles como texto", async () => {
    const leido = await armar();
    expect(await leido.file("01-XML SAT/BAL.XML")!.async("string")).toContain("<Balanza/>");
    expect(await leido.file("LEEME.txt")!.async("string")).toContain("PAQUETE CONTABLE");
  });

  it("el Excel sobrevive el viaje y sus importes siguen siendo números", async () => {
    // Si el binario se guardara como texto, esto reventaría al leer.
    const leido = await armar();
    const bytes = await leido.file("02-Estados financieros/Estados 2025-07.xlsx")!.async("nodebuffer");
    const wb = XLSX.read(bytes, { type: "buffer" });
    expect(wb.SheetNames).toContain("Balanza");
    const celda = wb.Sheets["Balanza"]["G2"]; // columna Cargos
    expect(celda.t).toBe("n");
    expect(celda.v).toBe(1500.5);
  });

  it("los acentos del manifiesto no se rompen", async () => {
    const leido = await armar();
    const txt = await leido.file("LEEME.txt")!.async("string");
    expect(txt).toContain("Periodo");
    expect(txt).toMatch(/envía/);
  });
});
