import { describe, expect, it, vi } from "vitest";
import {
  consultarCep, contraparteDeCep, institucionSpei, paramsDesdeMovimiento, parseCepXml,
} from "./cep-tlaloc";

// XML real que devolvió Banxico para un pago de este hospital a su proveedor.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<SPEI_Tercero FechaOperacion="2026-08-10" Hora="19:06:16" ClaveSPEI="40002" sello="b0EZ...">
<Ordenante BancoEmisor="BBVA MEXICO" Nombre="CENTRO DE PROCEDIMIE NTOS MINIMAMENTE IN" TipoCuenta="40" Cuenta="012650001208090123" RFC="CPM2307076Z9"/>
<Beneficiario BancoReceptor="BANAMEX" Nombre="ARKANUM SA DE CV" TipoCuenta="40" Cuenta="002180061014584644" RFC="ARK960326NR4" Concepto="MATERIAL MEDICO" IVA="0.00" MontoPago="2882.54"/>
</SPEI_Tercero>`;

describe("parseCepXml — el RFC que el estado de cuenta nunca trae", () => {
  it("saca ordenante y beneficiario completos", () => {
    const cep = parseCepXml(XML)!;
    expect(cep.beneficiario.rfc).toBe("ARK960326NR4");
    expect(cep.beneficiario.nombre).toBe("ARKANUM SA DE CV");
    expect(cep.ordenante.rfc).toBe("CPM2307076Z9");
    expect(cep.concepto).toBe("MATERIAL MEDICO");
    expect(cep.monto).toBe(2882.54);
  });

  it("colapsa los cortes de ancho fijo de Banxico sin inventar el nombre", () => {
    // Banxico parte los nombres a media palabra: se normalizan los espacios,
    // no se recompone — el dato bueno de esta consulta es el RFC.
    expect(parseCepXml(XML)!.ordenante.nombre).toBe("CENTRO DE PROCEDIMIE NTOS MINIMAMENTE IN");
  });

  it("un XML que no es CEP devuelve null", () => {
    expect(parseCepXml("<html>error</html>")).toBeNull();
    expect(parseCepXml("")).toBeNull();
  });
});

describe("institucionSpei", () => {
  it("«40» + los tres dígitos de banco de la CLABE", () => {
    expect(institucionSpei("002180061014584644")).toBe("40002");
    expect(institucionSpei("012650001208090123")).toBe("40012");
    expect(institucionSpei("072 650 01358620258 0")).toBe("40072");
  });
  it("sin CLABE no adivina", () => {
    expect(institucionSpei(null)).toBeNull();
    expect(institucionSpei("12")).toBeNull();
  });
});

describe("paramsDesdeMovimiento — la cuenta es la del BENEFICIARIO", () => {
  const base = { fecha: new Date("2026-08-07T12:00:00Z"), claveRastreo: "BNET0100", contraparteClabe: "002180061014584644" };
  const PROPIA = "012650001208090123";

  it("cargo (SPEI enviado): beneficiario = la contraparte", () => {
    const p = paramsDesdeMovimiento({ ...base, monto: -2882.54 }, PROPIA)!;
    expect(p).toMatchObject({ emisor: "40012", receptor: "40002", cuenta: "002180061014584644", monto: 2882.54, fecha: "2026-08-07" });
  });

  it("depósito (SPEI recibido): el beneficiario somos nosotros", () => {
    const p = paramsDesdeMovimiento({ ...base, monto: 5000 }, PROPIA)!;
    expect(p).toMatchObject({ emisor: "40002", receptor: "40012", cuenta: PROPIA, monto: 5000 });
  });

  it("sin clave de rastreo o sin CLABE no se puede consultar", () => {
    expect(paramsDesdeMovimiento({ ...base, monto: -1, claveRastreo: null }, PROPIA)).toBeNull();
    expect(paramsDesdeMovimiento({ ...base, monto: -1, contraparteClabe: null }, PROPIA)).toBeNull();
    expect(paramsDesdeMovimiento({ ...base, monto: -1 }, null)).toBeNull();
  });
});

describe("contraparteDeCep", () => {
  it("en un cargo la contraparte es el beneficiario; en un depósito, el ordenante", () => {
    const cep = parseCepXml(XML)!;
    expect(contraparteDeCep(cep, -2882.54).rfc).toBe("ARK960326NR4");
    expect(contraparteDeCep(cep, 2882.54).rfc).toBe("CPM2307076Z9");
  });
});

describe("consultarCep", () => {
  const P = { fecha: "2026-08-07", claveRastreo: "BNET0100", emisor: "40012", receptor: "40002", cuenta: "002180061014584644", monto: 2882.54 };

  it("devuelve el CEP cuando Banxico lo encuentra", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ found: true, xml_content: XML, estado: "Liquidado" }) });
    const cep = await consultarCep(P, { apiKey: "k", fetchImpl: f as never });
    expect(cep?.beneficiario.rfc).toBe("ARK960326NR4");
    expect(cep?.estado).toBe("Liquidado");
    const url = new URL((f.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("tipo_criterio")).toBe("T");
    expect(url.searchParams.get("monto")).toBe("2882.54");
  });

  it("«no encontrada» es una RESPUESTA, no un error: devuelve null", async () => {
    // Pasa de verdad con traspasos entre cuentas propias.
    const f = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ error: "http_error", message: { message: "Banxico no encontró…" }, details: "HTTP 404" }),
    });
    await expect(consultarCep(P, { apiKey: "k", fetchImpl: f as never })).resolves.toBeNull();
  });

  it("sin llave no intenta la llamada", async () => {
    const f = vi.fn();
    await expect(consultarCep(P, { apiKey: "", fetchImpl: f as never })).rejects.toThrow(/TLALOC_API_KEY/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("el RFC del CEP va sin espacios", () => {
  it("un corte de ancho fijo a medio RFC no rompe el empate", () => {
    // Caso real: Banxico entregó «GEP850101 1S6». Con el espacio, ese RFC no
    // empata con ninguna factura y el espacio no se ve al leerlo en pantalla.
    const xml = `<SPEI_Tercero FechaOperacion="2026-08-05">
      <Ordenante Nombre="SECRETARIA DE PLANEACION" RFC="GEP850101 1S6" Cuenta="012914002011633454" BancoEmisor="BBVA"/>
      <Beneficiario Nombre="CENTRO" RFC="CPM2307076Z9" Cuenta="072180001234567890" BancoReceptor="BANORTE" MontoPago="1000.00" Concepto="PAGO"/>
    </SPEI_Tercero>`;
    const cep = parseCepXml(xml);
    expect(cep?.ordenante.rfc).toBe("GEP8501011S6");
    expect(cep?.beneficiario.rfc).toBe("CPM2307076Z9");
  });
});
