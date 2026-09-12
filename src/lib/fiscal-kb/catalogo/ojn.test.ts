import { describe, expect, it } from "vitest";
import { ESTADOS, ddmmyyyy, entradaDesde, esNormativoDeConstruccion, parsearFicha, parsearListado, parsearSelectores, repararMojibake, slug } from "./ojn";

const FILA = (id: string, titulo: string, pub: string, ref: string, tipo: string) =>
  `<tr><td bgcolor="" align=left><a href=javascript:void(window.open("fichaOrdenamiento.php?idArchivo=${id}&ambito=ESTATAL","","width=495"))>${titulo}</a></td><td align=center>${pub}</td><td align=center>${ref}</td><td align=center>${tipo}</td></tr>`;

describe("parsearListado", () => {
  const html = [
    FILA("120421", "Reglamento Interior de la Fiscalia Anticorrupci&oacute;n del Gobierno del Estado", "06-09-2010", "Sin Reforma", "Reglamento"),
    FILA("98765", "Ley de Desarrollo Urbano Sustentable del Estado de Puebla", "05-06-2013", "31-12-2021", "Ley"),
    "<tr><td>T&iacute;tulo</td><td>Fecha</td><td>Reforma</td><td>Tipo</td></tr>",
  ].join("");
  const filas = parsearListado(html);
  it("una fila por idArchivo con título decodificado, fechas ISO y tipo", () => {
    expect(filas).toHaveLength(2);
    expect(filas[0]).toEqual({ idArchivo: "120421", titulo: "Reglamento Interior de la Fiscalia Anticorrupción del Gobierno del Estado", fechaPublicacion: "2010-09-06", ultimaReforma: null, tipo: "Reglamento" });
    expect(filas[1].ultimaReforma).toBe("2021-12-31");
  });
  it("«00-00-0000» y fechas imposibles son null, no una fecha inválida", () => {
    expect(ddmmyyyy("00-00-0000")).toBeNull();
    expect(ddmmyyyy("31-13-2010")).toBeNull();
    expect(ddmmyyyy("05-06-2013")).toBe("2013-06-05");
    const [f] = parsearListado(FILA("1", "Ley X", "00-00-0000", "00-00-0000", "Ley"));
    expect(f.fechaPublicacion).toBeNull();
    expect(f.ultimaReforma).toBeNull();
    expect(entradaDesde(f, { sat: "BCS", municipio: null }, { url: "http://x/a.pdf", estatus: "Vigente" }).vigenciaFallback).toBeNull();
  });
  it("títulos con UTF-8 metido en latin1 se reparan (y los sanos no se tocan)", () => {
    expect(repararMojibake("Reglamento de ProtecciÃ³n y Mejoramiento de la Imagen Urbana")).toBe("Reglamento de Protección y Mejoramiento de la Imagen Urbana");
    expect(repararMojibake("Ley de Protección Civil")).toBe("Ley de Protección Civil");
    const [f] = parsearListado(FILA("2", "Reglamento de TrÃ¡nsito y Vialidad", "01-02-2015", "Sin Reforma", "Reglamento"));
    expect(f.titulo).toBe("Reglamento de Tránsito y Vialidad");
    expect(entradaDesde(f, { sat: "JAL", municipio: "Puerto Vallarta" }, { url: "http://x/a.pdf", estatus: "Vigente" }).clave).toBe("JAL-M-PUERTO-VALLART-R-TRANSITO-VIALIDAD");
  });
  it("el filtro de construcción exige tipo normativo y título del ramo; los interiores quedan fuera", () => {
    expect(esNormativoDeConstruccion(filas[0])).toBe(false);
    expect(esNormativoDeConstruccion(filas[1])).toBe(true);
    expect(esNormativoDeConstruccion({ titulo: "Acuerdo por el que se determinan espacios públicos", tipo: "Acuerdo" })).toBe(false);
    expect(esNormativoDeConstruccion({ titulo: "Reglamento de Construcciones para el Municipio de Puebla", tipo: "Reglamento" })).toBe(true);
  });
});

describe("parsearSelectores y parsearFicha", () => {
  it("tipos con id y municipios con id", () => {
    const html = `<select name="catTipo"><option value="">--Seleccione--</option><option value="0">Todos los ordenamientos</option><option value="4">Ley (135)</option><option value="6">Reglamento (189)</option></select>
      <select name="catTipo"><option value="">--Seleccione--</option><OPTION value="2484"> Todos los Municipios</OPTION><OPTION value="1554" title='Acajete'> Acajete</OPTION><OPTION value="1667"> Puebla</OPTION></select>`;
    const s = parsearSelectores(html);
    expect(s.tipos).toEqual({ Ley: "4", Reglamento: "6" });
    expect(s.municipios).toEqual([{ id: "1554", nombre: "Acajete" }, { id: "1667", nombre: "Puebla" }]);
  });
  it("la ficha da el archivo y el estatus", () => {
    const f = parsearFicha(`<a href='http://www.ordenjuridico.gob.mx/./Documentos/Estatal/Puebla/wo120421.doc'>Descargar</a> Estatus: Vigente Tipo: Reglamento`);
    expect(f.url).toBe("http://www.ordenjuridico.gob.mx/Documentos/Estatal/Puebla/wo120421.doc");
    expect(f.estatus).toBe("Vigente");
    // Estados con espacio en el nombre: la URL entera, codificada.
    const g = parsearFicha(`<a href="http://www.ordenjuridico.gob.mx/./Documentos/Estatal/Baja California/wo9.pdf">Descargar</a>`);
    expect(g.url).toBe("http://www.ordenjuridico.gob.mx/Documentos/Estatal/Baja%20California/wo9.pdf");
    // Layout viejo (sin /Documentos/, ya codificado) y hojas de estilo antes del archivo.
    const h = parsearFicha(`<link href="scripts/styles.css"><a href="javascript:window.print();">Imprimir</a><a href="http://www.ordenjuridico.gob.mx/./Estatal/BAJA%20CALIFORNIA%20SUR/Leyes/BCSLEY07.pdf">Descargar</a> Estatus: Vigente Tipo: Ley`);
    expect(h.url).toBe("http://www.ordenjuridico.gob.mx/Estatal/BAJA%20CALIFORNIA%20SUR/Leyes/BCSLEY07.pdf");
    expect(h.estatus).toBe("Vigente");
  });
});

describe("entradaDesde", () => {
  const o = { idArchivo: "1", titulo: "Reglamento de Construcciones para el Municipio de Puebla", fechaPublicacion: "2010-01-15", ultimaReforma: "2022-03-01", tipo: "Reglamento" };
  it("clave legible con entidad, municipio, tipo y título; materias con construcción", () => {
    const e = entradaDesde(o, { sat: "PUE", municipio: "Puebla" }, { url: "http://x/Documentos/Municipal/Puebla/r.pdf", estatus: "Vigente" });
    expect(e.clave).toBe("PUE-M-PUEBLA-R-CONSTRUCCIONES-PUEBLA");
    expect(e.ambito).toBe("MUNICIPAL");
    expect(e.materias).toContain("construccion");
    expect(e.vigenciaFallback).toBe("2022-03-01");
    expect(e.excluida).toBeNull();
  });
  it("un formato raro o un no vigente quedan excluidos con motivo; .doc entra", () => {
    expect(entradaDesde(o, { sat: "PUE", municipio: null }, { url: "http://x/Documentos/Estatal/Puebla/wo1.doc", estatus: "Vigente" }).excluida).toBeNull();
    expect(entradaDesde(o, { sat: "PUE", municipio: null }, { url: "http://x/Documentos/Estatal/Puebla/wo1.zip", estatus: "Vigente" }).excluida).toMatch(/Formato/);
    expect(entradaDesde(o, { sat: "PUE", municipio: null }, { url: "http://x/a.pdf", estatus: "Abrogado" }).excluida).toMatch(/Abrogado/);
    expect(entradaDesde(o, { sat: "PUE", municipio: null }, { url: null, estatus: null }).excluida).toMatch(/archivo/);
  });
  it("slug quita ruido y acentos", () => {
    expect(slug("Ley de Desarrollo Urbano del Estado de Puebla", 28)).toBe("DESARROLLO-URBANO-PUEBLA");
  });
  it("los 32 estados con clave SAT única", () => {
    expect(ESTADOS).toHaveLength(32);
    expect(new Set(ESTADOS.map((e) => e.sat)).size).toBe(32);
    expect(ESTADOS.find((e) => e.id === 21)?.sat).toBe("PUE");
  });
});
