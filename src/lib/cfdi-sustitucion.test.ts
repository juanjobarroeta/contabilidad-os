import { describe, expect, it } from "vitest";
import { sustituidosDe } from "./cfdi-sustitucion";
import { relacionadosDeXml } from "./sat-fiel";

describe("sustituidosDe", () => {
  it("sólo la relación 04, en mayúsculas y sin repetir", () => {
    const rel = [
      { tipoRelacion: "01", uuids: ["AAAA-1"] },
      { tipoRelacion: "04", uuids: ["bbbb-2", "BBBB-2", "cccc-3"] },
    ];
    expect(sustituidosDe(rel, "ZZZZ-9")).toEqual(["BBBB-2", "CCCC-3"]);
  });

  it("un CFDI no se sustituye a sí mismo", () => {
    expect(sustituidosDe([{ tipoRelacion: "04", uuids: ["zzzz-9"] }], "ZZZZ-9")).toEqual([]);
  });

  it("sin relación 04, nada", () => {
    expect(sustituidosDe([{ tipoRelacion: "07", uuids: ["AAAA-1"] }], "ZZZZ-9")).toEqual([]);
  });
});

describe("relacionadosDeXml sobre el tramo que corta el cron", () => {
  it("lee varios nodos CfdiRelacionados seguidos (4.0) — el 04 puede no ser el primero", () => {
    const tramo =
      '<cfdi:CfdiRelacionados TipoRelacion="01"><cfdi:CfdiRelacionado UUID="aaaa-1"/></cfdi:CfdiRelacionados>' +
      '<cfdi:CfdiRelacionados TipoRelacion="04"><cfdi:CfdiRelacionado UUID="bbbb-2"/></cfdi:CfdiRelacionados>';
    expect(sustituidosDe(relacionadosDeXml(tramo), "ZZZZ-9")).toEqual(["BBBB-2"]);
  });

  it("REP sustituto 3.3 con namespace pago10 en el resto del XML", () => {
    const tramo = '<cfdi:CfdiRelacionados TipoRelacion="04">\n  <cfdi:CfdiRelacionado UUID="86A870D4-0000-0000-0000-000000000000" />\n</cfdi:CfdiRelacionados>';
    expect(sustituidosDe(relacionadosDeXml(tramo), "3FC41A8A-0000-0000-0000-000000000000")).toEqual([
      "86A870D4-0000-0000-0000-000000000000",
    ]);
  });
});
