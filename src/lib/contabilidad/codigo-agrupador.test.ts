import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CODIGO_AGRUPADOR_OFICIAL } from "./codigo-agrupador";
import { CODIGOS_AGRUPADOR_SAT } from "./codigo-agrupador-sat";
import { esAgrupadorOficial } from "./agrupador";
import { COE_CODES, SAT_STARTER_CATALOG } from "./catalog";
import { EXTRA_ACCOUNTS_FOR_CLASSIFICATION } from "./classify-egreso";

// ─────────────────────────────────────────────────────────────────────────────
// Guardas contra códigos agrupadores inventados. El bug original: el bloque
// 601.xx del catálogo semilla se asignó secuencialmente, así que combustibles
// caía en 601.15 («Despensa» oficial), el IMSS patronal en 601.14 («Destajo»)
// y el ISR retenido de nómina en 214.01 («Dividendos por pagar»). Estas
// pruebas hacen imposible reintroducirlo: todo código usado por el catálogo,
// el clasificador o el motor debe existir en la lista OFICIAL del Anexo 24, y
// los nombres sembrados deben coincidir letra por letra.
// ─────────────────────────────────────────────────────────────────────────────

describe("CODIGO_AGRUPADOR_OFICIAL", () => {
  it("todo código de la lista oficial existe en el XSD del SAT (c_CodAgrup)", () => {
    const xsd = readFileSync(join(__dirname, "xsd", "CatalogosParaEsqContE.xsd"), "utf8");
    const m = /c_CodAgrup[\s\S]*?<\/xs:simpleType>/.exec(xsd);
    expect(m).toBeTruthy();
    const xsdCodes = new Set(
      [...m![0].matchAll(/enumeration value="([0-9]{3}(?:\.[0-9]{2})?)"/g)].map((x) => x[1])
    );
    for (const code of Object.keys(CODIGO_AGRUPADOR_OFICIAL)) {
      expect(xsdCodes.has(code), `código ${code} no está en el XSD`).toBe(true);
    }
  });
});

describe("COE_CODES", () => {
  it("cada código apunta a un código agrupador oficial", () => {
    for (const [key, code] of Object.entries(COE_CODES)) {
      expect(CODIGO_AGRUPADOR_OFICIAL[code], `${key} → ${code} no existe en el código agrupador oficial`).toBeDefined();
    }
  });
});

describe("SAT_STARTER_CATALOG", () => {
  it("cada cuenta usa un código oficial y el nombre OFICIAL exacto", () => {
    for (const acc of SAT_STARTER_CATALOG) {
      const code = acc.subcuenta ?? acc.cuentaSAT;
      const oficial = CODIGO_AGRUPADOR_OFICIAL[code];
      expect(oficial, `cuenta ${code} («${acc.nombre}») no existe en el código agrupador oficial`).toBeDefined();
      expect(acc.nombre, `nombre de ${code} difiere del oficial`).toBe(oficial);
    }
  });

  it("no hay códigos duplicados en la semilla", () => {
    const all = [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION].map(
      (a) => a.subcuenta ?? a.cuentaSAT
    );
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("EXTRA_ACCOUNTS_FOR_CLASSIFICATION", () => {
  it("cada cuenta del clasificador usa código y nombre oficiales", () => {
    for (const acc of EXTRA_ACCOUNTS_FOR_CLASSIFICATION) {
      const oficial = CODIGO_AGRUPADOR_OFICIAL[acc.subcuenta];
      expect(oficial, `cuenta ${acc.subcuenta} («${acc.nombre}») no existe en el oficial`).toBeDefined();
      expect(acc.nombre, `nombre de ${acc.subcuenta} difiere del oficial`).toBe(oficial);
    }
  });

  it("toda cuenta destino del MAPPING existe en la semilla combinada", async () => {
    const { classifyEgreso } = await import("./classify-egreso");
    const seeded = new Set(
      [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION].map((a) => a.subcuenta ?? a.cuentaSAT)
    );
    // Muestra de claves representativas de cada familia del MAPPING.
    const claves = ["15101000", "80121500", "80131500", "80141600", "81111500", "81161700",
      "43231500", "78181500", "90101500", "83101500", "83111500", "72141000", "76101500",
      "84131500", "84121600", "44121600", "50101500", "82141500", "86111600", "99999999"];
    for (const clave of claves) {
      const { cuenta } = classifyEgreso(clave);
      expect(CODIGO_AGRUPADOR_OFICIAL[cuenta], `classify(${clave}) → ${cuenta} no es código oficial`).toBeDefined();
      expect(seeded.has(cuenta), `classify(${clave}) → ${cuenta} no está sembrada`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La otra dirección, que es la que faltaba y costó siete cierres.
//
// La prueba de arriba comprueba que no INVENTAMOS códigos. Nadie comprobaba
// que no nos FALTARAN: al mapa de nombres le faltaban 171.03, 613.03, 703.04 y
// 704.04 —equipo de transporte, en el XSD del SAT desde siempre— y como la
// validez del cierre se leía de ese mapa, siete empresas no podían cerrar el
// mes. El mensaje decía «cuenta sin código agrupador» sobre cuentas que lo
// tenían, y bien puesto.
// ─────────────────────────────────────────────────────────────────────────────

describe("CODIGOS_AGRUPADOR_SAT (generado del XSD)", () => {
  const delXsd = () => {
    const lineas = readFileSync(join(__dirname, "xsd", "CatalogosParaEsqContE.xsd"), "utf8").split("\n");
    // Sólo c_CodAgrup: el XSD trae además c_Moneda, c_Banco y c_MetPagos, y
    // los códigos de banco (002 Banamex, 012 BBVA, 014 Santander…) se parecen
    // lo bastante a un agrupador como para colarse en un regex ingenuo.
    const inicio = lineas.findIndex((l) => l.includes('simpleType name="c_CodAgrup"'));
    const fin = lineas.findIndex((l, i) => i > inicio && l.includes("</xs:simpleType>"));
    const bloque = lineas.slice(inicio, fin).join("\n");
    return new Set([...bloque.matchAll(/value="([^"]+)"/g)].map((m) => m[1]));
  };

  it("es EXACTAMENTE la enumeración del XSD", () => {
    expect([...CODIGOS_AGRUPADOR_SAT].sort()).toEqual([...delXsd()].sort());
  });

  it("acepta los códigos de equipo de transporte que bloqueaban el cierre", () => {
    for (const c of ["171.03", "613.03", "703.04", "704.04"]) {
      expect(esAgrupadorOficial(c)).toBe(true);
    }
  });

  it("todo código del XSD es válido, tenga nombre o no", () => {
    // Es el punto: que falte un NOMBRE no puede impedir cerrar un mes.
    const sinNombre = [...delXsd()].filter((c) => !(c in CODIGO_AGRUPADOR_OFICIAL));
    for (const c of sinNombre) expect(esAgrupadorOficial(c)).toBe(true);
  });

  it("el mapa de nombres nunca tiene códigos que el SAT no acepte", () => {
    const inventados = Object.keys(CODIGO_AGRUPADOR_OFICIAL).filter((c) => !CODIGOS_AGRUPADOR_SAT.has(c));
    expect(inventados).toEqual([]);
  });
});
