import { describe, expect, it } from "vitest";
import {
  bancoDeClabe,
  clabeValida,
  esSpeiInterbancario,
  pareceClaveRastreo,
  parseSpei,
} from "./spei-descripcion";

// Renglón REAL de un estado de cuenta Banorte (el mismo fixture que usa
// bank-parser.test.ts). La columna DESCRIPCIÓN trae la clave de rastreo y la
// DESCRIPCIÓN DETALLADA trae todo lo demás.
const BANORTE_RECIBIDO =
  "SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689";
const BANORTE_CLAVE = "20260703400140HDH0000485641770";

const BANORTE_ENVIADO =
  "=REFERENCIA  CTA/CLABE: 012180015437920135, BEM SPEI, Pago 1 Julio a Coach Ana";

describe("clabeValida", () => {
  it("acepta una CLABE real (dígito de control correcto)", () => {
    // Tomada del estado de cuenta Banorte del fixture.
    expect(clabeValida("012180015437920135")).toBe(true);
  });

  it("rechaza la misma CLABE con el dígito de control cambiado", () => {
    expect(clabeValida("012180015437920134")).toBe(false);
  });

  it("rechaza un dígito interior alterado — el caso que de verdad importa", () => {
    // Un OCR que confunde un 8 por un 3 apunta a la cuenta de alguien más.
    expect(clabeValida("012130015437920135")).toBe(false);
  });

  it("rechaza longitudes y caracteres que no son CLABE", () => {
    for (const c of ["", "12345", "01218001543792013", "0121800154379201355", "01218001543792013X"]) {
      expect(clabeValida(c)).toBe(false);
    }
  });
});

describe("bancoDeClabe", () => {
  it("devuelve los 3 dígitos de la institución", () => {
    expect(bancoDeClabe("012180015437920135")).toBe("012"); // BBVA
  });

  it("no devuelve banco de una CLABE inválida", () => {
    expect(bancoDeClabe("012180015437920134")).toBeUndefined();
  });
});

describe("pareceClaveRastreo", () => {
  it("acepta la clave real de Banorte", () => {
    expect(pareceClaveRastreo(BANORTE_CLAVE)).toBe(true);
  });

  it("rechaza folios y consecutivos cortos — el falso positivo caro", () => {
    // Si esto pasara, pediríamos CEPs con basura y pagaríamos por nada.
    for (const t of ["0", "-", "74", "160726", "5663", ""]) {
      expect(pareceClaveRastreo(t)).toBe(false);
    }
  });

  it("rechaza texto con espacios o signos", () => {
    for (const t of ["SPEI RECIBIDO", "CLAVE-DE-RASTREO-123", "20260703 400140HDH"]) {
      expect(pareceClaveRastreo(t)).toBe(false);
    }
  });

  it("rechaza una palabra larga sin dígitos", () => {
    expect(pareceClaveRastreo("TRANSFERENCIA")).toBe(false);
  });
});

describe("parseSpei — depósito Banorte (caso real)", () => {
  const d = parseSpei(BANORTE_RECIBIDO, BANORTE_CLAVE);

  it("rescata la clave de rastreo de la columna que se descartaba", () => {
    expect(d.claveRastreo).toBe(BANORTE_CLAVE);
  });

  it("saca el nombre de la contraparte", () => {
    expect(d.contraparteNombre).toBe("STRIPE PAYMENTS MEXICO S DE RL DE CV");
  });

  it("saca banco, concepto y referencia numérica", () => {
    expect(d.bancoContraparteCodigo).toBe("014"); // BCO:0014 → Santander
    expect(d.bancoContraparteNombre).toBe("SANTANDER");
    expect(d.concepto).toBe("STRIPE");
    expect(d.referenciaNumerica).toBe("693689"); // sin ceros a la izquierda
  });

  it("no inventa RFC ni CLABE cuando el banco no los puso", () => {
    expect(d.contraparteRfc).toBeUndefined();
    expect(d.contraparteClabe).toBeUndefined();
  });
});

describe("parseSpei — envío Banorte (caso real)", () => {
  const d = parseSpei(BANORTE_ENVIADO);

  it("saca la CLABE del beneficiario y su institución", () => {
    expect(d.contraparteClabe).toBe("012180015437920135");
    expect(d.bancoContraparteCodigo).toBe("012");
  });

  it("no confunde '=REFERENCIA' suelto con una referencia numérica", () => {
    expect(d.referenciaNumerica).toBeUndefined();
  });

  it("sin columna críptica no hay clave de rastreo inventada", () => {
    expect(d.claveRastreo).toBeUndefined();
  });
});

describe("parseSpei — razón social partida por la coma", () => {
  it("vuelve a pegar el sufijo que la coma separó", () => {
    const d = parseSpei(
      "SPEI RECIBIDO, DEL CLIENTE STRIPE PAYMENTS MEXICO, S. DE R.L. DE C.V., CONCEPTO: PAGO"
    );
    expect(d.contraparteNombre).toBe("STRIPE PAYMENTS MEXICO S. DE R.L. DE C.V.");
    // Y el segmento pegado no se comió el concepto que venía después.
    expect(d.concepto).toBe("PAGO");
  });

  it("acepta SA DE CV igual que S DE RL DE CV", () => {
    const d = parseSpei("DEL CLIENTE CONSTRUCTORA DEL NORTE, S.A. DE C.V., CONCEPTO: ESTIMACION 3");
    expect(d.contraparteNombre).toBe("CONSTRUCTORA DEL NORTE S.A. DE C.V.");
    expect(d.concepto).toBe("ESTIMACION 3");
  });
});

describe("parseSpei — RFC explícito", () => {
  it("lo toma cuando el banco lo escribe", () => {
    expect(parseSpei("SPEI RECIBIDO XAXX010101000 PAGO").contraparteRfc).toBe("XAXX010101000");
  });

  it("toma también el de persona moral (12 posiciones)", () => {
    expect(parseSpei("SPEI DEL CLIENTE ABC123456AB1").contraparteRfc).toBe("ABC123456AB1");
  });
});

describe("parseSpei — no rompe con basura", () => {
  it("descripción vacía devuelve objeto vacío", () => {
    expect(parseSpei("")).toEqual({});
    expect(parseSpei("   ")).toEqual({});
  });

  it("descripción sin estructura no inventa campos", () => {
    expect(parseSpei("DEPOSITO EFECTIVO SUCURSAL")).toEqual({});
  });

  it("una CLABE con dígito de control malo se descarta, no se guarda", () => {
    const d = parseSpei("CTA/CLABE: 012180015437920134, PAGO");
    expect(d.contraparteClabe).toBeUndefined();
    expect(d.bancoContraparteCodigo).toBeUndefined();
  });
});

describe("esSpeiInterbancario", () => {
  it("reconoce los SPEI que sí tienen CEP", () => {
    for (const d of [
      "SPEI RECIBIDO, BCO:0014 SANTANDER",
      "COMPRA ORDEN DE PAGO SPEI",
      "sweb transf. interb spei",
      "TRANSFERENCIA INTERBANCARIA",
    ]) {
      expect(esSpeiInterbancario(d)).toBe(true);
    }
  });

  it("descarta lo que NO genera comprobante — consultarlo es gastar de más", () => {
    for (const d of [
      "TRASPASO ENTRE CUENTAS",
      "DEPOSITO EFECTIVO",
      "PAGO TARJETA DE CREDITO",
      "(BANCA POR INTERNET), CARGO POR COMISION CEP", // comisión, no transferencia
      "IVA COMISION SPEI",
      "",
    ]) {
      expect(esSpeiInterbancario(d)).toBe(false);
    }
  });
});
