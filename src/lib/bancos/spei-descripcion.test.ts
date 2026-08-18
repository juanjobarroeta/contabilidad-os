import { describe, expect, it } from "vitest";
import {
  bancoDeClabe,
  clabeValida,
  esComisionDeTransferencia,
  esSpeiInterbancario,
  pareceClaveRastreo,
  parseSpei,
} from "./spei-descripcion";

// ── Renglones REALES de estado de cuenta ─────────────────────────────────────
// Banorte: separa con COMAS, y la clave de rastreo va en una columna aparte
// (la misma que bank-parser.test.ts descarta por "críptica").
const BANORTE_RECIBIDO =
  "SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689";
const BANORTE_CLAVE = "20260703400140HDH0000485641770";
const BANORTE_ENVIADO =
  "=REFERENCIA  CTA/CLABE: 012180015437920135, BEM SPEI, Pago 1 Julio a Coach Ana";

// Banco del Bajío: separa con PIPES, mete DOS etiquetas en un mismo tramo
// ("Cuenta Beneficiario: … RFC Beneficiario: …") y trae la clave de rastreo
// etiquetada dentro del propio texto.
const BAJIO_ENVIADO =
  "SPEI Enviado: | Institucion Receptora: NU MEXICO | Beneficiario: KATIA FABIOLA CORDERO BERNARDINO (Dato no verificado por esta institucion) | Cuenta Beneficiario: 638180000152107570 RFC Beneficiario: ND | Referencia: 2772602 | Hora: 11:29:46 | Clave de Rastreo: BB27726020704 Concepto del Pago: PAGO N";
const BAJIO_COMISION =
  "Comision por Transferencia - Envio ; (SPEI; Banca por Internet) | Referencia: 2772602 | Clave de Rastreo: BB27726020704";
const BAJIO_IMPUESTOS =
  "Retiro de Recursos Pago de impuestos RFC | Pago Referenciado | Folio: 31087077681 por BajioNet | por (800.00) mxn | REF. 04265F9T970050618402 | Beneficiario | TESOFE INGRESOS FEDERALES REC | Hora: 11:17:52 | Recibo # 4505264631087";

describe("clabeValida", () => {
  it("acepta CLABEs reales de dos bancos distintos", () => {
    expect(clabeValida("012180015437920135")).toBe(true); // BBVA, estado Banorte
    expect(clabeValida("638180000152107570")).toBe(true); // NU MEXICO, estado Bajío
  });

  it("rechaza el dígito de control cambiado", () => {
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
    expect(bancoDeClabe("012180015437920135")).toBe("012");
    expect(bancoDeClabe("638180000152107570")).toBe("638");
  });

  it("no devuelve banco de una CLABE inválida", () => {
    expect(bancoDeClabe("012180015437920134")).toBeUndefined();
  });
});

describe("pareceClaveRastreo", () => {
  it("acepta claves reales de ambos bancos", () => {
    expect(pareceClaveRastreo(BANORTE_CLAVE)).toBe(true);
    expect(pareceClaveRastreo("BB27726020704")).toBe(true);
  });

  it("rechaza folios y consecutivos cortos — el falso positivo caro", () => {
    // Si esto pasara, pediríamos CEPs con basura y pagaríamos por nada.
    for (const t of ["0", "-", "74", "160726", "5663", ""]) {
      expect(pareceClaveRastreo(t)).toBe(false);
    }
  });

  it("rechaza texto con espacios o signos, y palabras sin dígitos", () => {
    for (const t of ["SPEI RECIBIDO", "CLAVE-DE-RASTREO-123", "TRANSFERENCIA"]) {
      expect(pareceClaveRastreo(t)).toBe(false);
    }
  });
});

// ── Bajío: el formato que rompió la primera versión del motor ────────────────
describe("parseSpei — Banco del Bajío, SPEI enviado (caso real)", () => {
  const d = parseSpei(BAJIO_ENVIADO);

  it("saca los siete campos de una sola cadena", () => {
    expect(d).toEqual({
      bancoContraparteNombre: "NU MEXICO",
      contraparteNombre: "KATIA FABIOLA CORDERO BERNARDINO",
      contraparteClabe: "638180000152107570",
      bancoContraparteCodigo: "638",
      referenciaNumerica: "2772602",
      hora: "11:29:46",
      claveRastreo: "BB27726020704",
      concepto: "PAGO N",
    });
  });

  it("lee las DOS etiquetas pegadas en un mismo tramo", () => {
    // "Cuenta Beneficiario: 638… RFC Beneficiario: ND" — partir por "|" habría
    // dejado la CLABE y el RFC en un solo pedazo sin separar.
    expect(d.contraparteClabe).toBe("638180000152107570");
  });

  it("descarta 'ND' en vez de guardarlo como RFC", () => {
    expect(d.contraparteRfc).toBeUndefined();
  });

  it("quita la aclaración entre paréntesis del nombre", () => {
    expect(d.contraparteNombre).not.toContain("Dato no verificado");
  });
});

describe("parseSpei — Bajío con RFC poblado: el dato gratis", () => {
  it("toma el RFC del campo propio del banco, sin pedirle nada a Banxico", () => {
    const d = parseSpei(
      "SPEI Recibido: | Institucion Emisora: BBVA | Beneficiario: ZIONX SA DE CV | Cuenta Beneficiario: 012180015437920135 RFC Beneficiario: ZIO190321JI6 | Referencia: 4251954 | Clave de Rastreo: BB4251954020513"
    );
    expect(d.contraparteRfc).toBe("ZIO190321JI6");
    expect(d.contraparteNombre).toBe("ZIONX SA DE CV");
    expect(d.claveRastreo).toBe("BB4251954020513");
  });
});

describe("parseSpei — Bajío, comisión de transferencia", () => {
  const d = parseSpei(BAJIO_COMISION);

  it("comparte clave de rastreo y referencia con el envío que la generó", () => {
    // Eso permite colgarla de su transferencia en vez de dejarla como un gasto
    // suelto que alguien concilia a mano cada mes.
    expect(d.claveRastreo).toBe("BB27726020704");
    expect(d.referenciaNumerica).toBe("2772602");
    expect(parseSpei(BAJIO_ENVIADO).claveRastreo).toBe(d.claveRastreo);
  });

  it("se reconoce como comisión y NO como SPEI consultable", () => {
    expect(esComisionDeTransferencia(BAJIO_COMISION)).toBe(true);
    expect(esSpeiInterbancario(BAJIO_COMISION)).toBe(false);
  });
});

describe("parseSpei — Bajío, pago de impuestos", () => {
  const d = parseSpei(BAJIO_IMPUESTOS);

  it("saca la LÍNEA DE CAPTURA — empata directo contra TaxDeclaration", () => {
    expect(d.lineaCaptura).toBe("04265F9T970050618402");
  });

  it("saca al beneficiario aunque venga con pipe en vez de dos puntos", () => {
    expect(d.contraparteNombre).toBe("TESOFE INGRESOS FEDERALES REC");
  });

  it("no lo confunde con un SPEI: no hay CEP que pedir", () => {
    expect(esSpeiInterbancario(BAJIO_IMPUESTOS)).toBe(false);
  });

  it("no toma un folio de puros dígitos como línea de captura", () => {
    // "Folio: 31087077681" y "Recibo # 4505264631087" no son líneas de captura.
    expect(parseSpei("REF. 04265012970050618402 | PAGO").lineaCaptura).toBeUndefined();
  });
});

// ── Banorte: el formato de comas sigue funcionando ───────────────────────────
describe("parseSpei — Banorte, depósito (caso real)", () => {
  const d = parseSpei(BANORTE_RECIBIDO, BANORTE_CLAVE);

  it("rescata la clave de rastreo de la columna que se descartaba", () => {
    expect(d.claveRastreo).toBe(BANORTE_CLAVE);
  });

  it("saca nombre, banco, concepto y referencia", () => {
    expect(d.contraparteNombre).toBe("STRIPE PAYMENTS MEXICO S DE RL DE CV");
    expect(d.bancoContraparteCodigo).toBe("014"); // BCO:0014 → Santander
    expect(d.bancoContraparteNombre).toBe("SANTANDER");
    expect(d.concepto).toBe("STRIPE");
    expect(d.referenciaNumerica).toBe("693689"); // sin ceros a la izquierda
  });
});

describe("parseSpei — Banorte, envío (caso real)", () => {
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

describe("parseSpei — razón social con coma adentro", () => {
  it("no la parte: el valor corre hasta la siguiente etiqueta", () => {
    const d = parseSpei(
      "SPEI RECIBIDO, DEL CLIENTE STRIPE PAYMENTS MEXICO, S. DE R.L. DE C.V., CONCEPTO: PAGO"
    );
    expect(d.contraparteNombre).toBe("STRIPE PAYMENTS MEXICO, S. DE R.L. DE C.V.");
    expect(d.concepto).toBe("PAGO");
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
    for (const d of [BAJIO_ENVIADO, BANORTE_RECIBIDO, "sweb transf. interb spei", "TRANSFERENCIA INTERBANCARIA"]) {
      expect(esSpeiInterbancario(d)).toBe(true);
    }
  });

  it("descarta lo que NO genera comprobante — consultarlo es gastar de más", () => {
    for (const d of [
      "TRASPASO ENTRE CUENTAS",
      "DEPOSITO EFECTIVO",
      "PAGO TARJETA DE CREDITO",
      BAJIO_COMISION,
      BAJIO_IMPUESTOS,
      "IVA COMISION SPEI",
      "",
    ]) {
      expect(esSpeiInterbancario(d)).toBe(false);
    }
  });
});
