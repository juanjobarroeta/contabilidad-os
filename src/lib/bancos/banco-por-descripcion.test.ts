import { describe, expect, it } from "vitest";
import { inferirBancoPorDescripciones } from "./banco-por-descripcion";

const BANORTE = [
  "SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689",
  "(BANCA POR INTERNET), CARGO POR COMISION CEP",
  "=REFERENCIA  CTA/CLABE: 012180015437920135, BEM SPEI, Pago 1 Julio a Coach Ana",
  "=REFERENCIA CTA/CLABE: 036650500676713195, BEM SPEI, BCO:036 BENEF:CLICK STOR (DATO NO VERIFICADO, POR ESTA INSTITUCION), Click Store Juanjo Software de ENA VIMA, CVE RASTREO: 8846APR1202608285703201003 RFC: CST170704JEO, IVA: 000000000.00 INBURSA HORA LIQ: 11:15:20",
];

const SCOTIA = [
  "sweb transf. interb spei",
  "sweb pago tarjeta de credito",
  "d local rest rappipro",
  "iva transf recepcion internacional",
  "cobranza con recibo 1415",
];

const BAJIO = [
  "SPEI Enviado: | Institucion Receptora: NU MEXICO | Beneficiario: KATIA FABIOLA CORDERO BERNARDINO | Cuenta Beneficiario: 638180000152107570 RFC Beneficiario: ND | Referencia: 2772602 | Clave de Rastreo: BB27726020704",
  "SPEI Recibido: | Institucion Emisora: BBVA MEXICO | Ordenante: JUAN PEREZ | Cuenta Ordenante: 012180001234567890 | Clave de Rastreo: BNET01002506120001",
];

describe("inferirBancoPorDescripciones", () => {
  it("reconoce Banorte por sus etiquetas (BCO:, =REFERENCIA CTA/CLABE, BEM SPEI)", () => {
    expect(inferirBancoPorDescripciones(BANORTE)).toBe("Banorte");
  });

  it("reconoce Banco del Bajío por sus tramos con pipes", () => {
    expect(inferirBancoPorDescripciones(BAJIO)).toBe("Banco del Bajío");
  });

  it("no afirma nada con el pegado en minúsculas de Scotiabank", () => {
    expect(inferirBancoPorDescripciones(SCOTIA)).toBeNull();
  });

  it("basta con que una fracción clara del lote lleve la firma (lote mixto real: 13 de 22)", () => {
    const lote = [...BANORTE, ...BANORTE, ...BANORTE, ...SCOTIA, ...SCOTIA]; // 12 Banorte, 10 no
    expect(inferirBancoPorDescripciones(lote)).toBe("Banorte");
  });

  it("un solo renglón con firma en un lote grande no alcanza", () => {
    expect(inferirBancoPorDescripciones([BANORTE[0], ...SCOTIA, ...SCOTIA])).toBeNull();
  });

  it("un lote de un solo renglón se decide con ese renglón", () => {
    expect(inferirBancoPorDescripciones([BANORTE[1]])).toBe("Banorte");
    expect(inferirBancoPorDescripciones([SCOTIA[0]])).toBeNull();
  });

  it("vacío o sólo blancos → null", () => {
    expect(inferirBancoPorDescripciones([])).toBeNull();
    expect(inferirBancoPorDescripciones(["", "   "])).toBeNull();
  });

  it("dos bancos que compiten → null (no adivina)", () => {
    expect(inferirBancoPorDescripciones([...BANORTE, ...BAJIO, ...BAJIO])).toBeNull();
  });
});
