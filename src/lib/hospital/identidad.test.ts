import { describe, expect, it } from "vitest";
import { validarRfc } from "@/lib/fiscal/verificador/estructura";
import { digitoVerificadorCurp, validarCurp } from "./curp";
import {
  calcularCurp,
  calcularRfc,
  compararConRenapo,
  cruzarCurpRfc,
  dividirNombre,
  entidadCurpDe,
  homoclaveRfc,
  identidadDePaciente,
  letrasCurp,
  letrasRfc,
  normalizarNombre,
  palabraSignificativa,
  type PacienteIdentidadEntrada,
} from "./identidad";

describe("normalización de nombres", () => {
  it("quita acentos y puntuación, conserva la Ñ", () => {
    expect(normalizarNombre("Núñez-Ibáñez, Ma. José")).toBe("NUÑEZ IBAÑEZ MA JOSE");
    expect(palabraSignificativa("de la O")).toBe("O");
    expect(palabraSignificativa("María Fernanda", true)).toBe("FERNANDA");
    expect(palabraSignificativa("María de los Ángeles", true)).toBe("ANGELES");
    expect(palabraSignificativa("María", true)).toBe("MARIA");
  });

  it("resuelve la entidad por letras, clave DGIS o nombre", () => {
    expect(entidadCurpDe("PL")).toBe("PL");
    expect(entidadCurpDe("21")).toBe("PL");
    expect(entidadCurpDe("9")).toBe("DF");
    expect(entidadCurpDe("Puebla")).toBe("PL");
    expect(entidadCurpDe("Ciudad de México")).toBe("DF");
    expect(entidadCurpDe("Distrito Federal")).toBe("DF");
    expect(entidadCurpDe("ZZ")).toBeNull();
  });
});

describe("calcularCurp (algoritmo de RENAPO, homoclave supuesta)", () => {
  it("reproduce una CURP real: Concepción Salgado Briseño, 26-jun-1956, mujer, DF", () => {
    const r = calcularCurp({ nombres: "Concepción", primerApellido: "Salgado", segundoApellido: "Briseño", fechaNacimiento: "1956-06-26", sexo: "M", entidadClave: "DF" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.curp).toBe("SABC560626MDFLRN01");
    expect(r.homoclaveSupuesta).toBe("0");
    expect(r.probable).toBe(true);
    expect(validarCurp(r.curp).valida).toBe(true);
  });

  it("MARIA/JOSE compuestos usan el segundo nombre; acepta HospSexo y clave DGIS", () => {
    const r = calcularCurp({ nombres: "María Fernanda", primerApellido: "Ortega", segundoApellido: "Ruiz", fechaNacimiento: "1992-03-14", sexo: "FEMENINO", entidadClave: "21" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.curp).toBe("OERF920314MPLRZR0" + digitoVerificadorCurp("OERF920314MPLRZR0"));
  });

  it("nacidos desde 2000 llevan homoclave supuesta A", () => {
    const r = calcularCurp({ nombres: "Diego", primerApellido: "Luna", segundoApellido: "Paz", fechaNacimiento: new Date(2001, 4, 20, 12), sexo: "H", entidadClave: "JC" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.curp.slice(0, 17)).toBe("LUPD010520HJCNZGA");
      expect(validarCurp(r.curp).fechaNacimiento?.getUTCFullYear()).toBe(2001);
    }
  });

  it("partículas, apellido de una letra, falta de segundo apellido y Ñ → X", () => {
    expect(letrasCurp("José Luis", "de la O", "Hernández")).toEqual({ letras: "OXHL", consonantes: "XRS" });
    expect(letrasCurp("Ana", "Torres", null)).toEqual({ letras: "TOXA", consonantes: "RXN" });
    expect(letrasCurp("Ángel", "Ñuñez", "Núñez")).toEqual({ letras: "XUNA", consonantes: "XXN" });
  });

  it("palabras antisonantes: RENAPO cambia la segunda letra por X", () => {
    expect(letrasCurp("Isabel", "Buendía", "Eslava").letras).toBe("BXEI");
  });

  it("rechaza sexo X, entidad desconocida y fecha imposible con motivo", () => {
    expect(calcularCurp({ nombres: "A", primerApellido: "B", fechaNacimiento: "1990-01-01", sexo: "X", entidadClave: "PL" })).toMatchObject({ ok: false, error: expect.stringMatching(/H o M/) });
    expect(calcularCurp({ nombres: "A", primerApellido: "B", fechaNacimiento: "1990-01-01", sexo: "H", entidadClave: "QQ" })).toMatchObject({ ok: false, error: expect.stringMatching(/Entidad/) });
    expect(calcularCurp({ nombres: "A", primerApellido: "B", fechaNacimiento: "1990-02-30", sexo: "H", entidadClave: "PL" })).toMatchObject({ ok: false, error: expect.stringMatching(/fecha/) });
    expect(calcularCurp({ nombres: "", primerApellido: "B", fechaNacimiento: "1990-01-01", sexo: "H", entidadClave: "PL" }).ok).toBe(false);
  });
});

describe("calcularRfc (persona física, algoritmo del SAT)", () => {
  it("reproduce el ejemplo del instructivo: Emma Gómez Díaz, 31-dic-1956 → GODE561231GR8", () => {
    const r = calcularRfc({ nombres: "Emma", primerApellido: "Gómez", segundoApellido: "Díaz", fechaNacimiento: "1956-12-31" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rfc).toBe("GODE561231GR8");
    expect(r.homoclave).toBe("GR");
    expect(homoclaveRfc("GOMEZ DIAZ EMMA")).toBe("GR");
    const v = validarRfc(r.rfc);
    expect(v.formatoValido).toBe(true);
    expect(v.digitoVerificador).toBe("valido");
  });

  it("el dígito verificador siempre cuadra con el validador estructural del hub", () => {
    for (const d of [
      { nombres: "María Fernanda", primerApellido: "Ortega", segundoApellido: "Ruiz", fechaNacimiento: "1992-03-14" },
      { nombres: "Juan", primerApellido: "Pérez", segundoApellido: null, fechaNacimiento: "1980-01-01" },
      { nombres: "Alicia", primerApellido: "Ro", segundoApellido: "Sánchez", fechaNacimiento: "1975-07-07" },
      { nombres: "Ángel", primerApellido: "Ñuñez", segundoApellido: "Núñez", fechaNacimiento: "1999-12-12" },
    ]) {
      const r = calcularRfc(d);
      expect(r.ok).toBe(true);
      if (r.ok) expect(validarRfc(r.rfc).digitoVerificador, r.rfc).toBe("valido");
    }
  });

  it("reglas de las cuatro letras: sin materno, paterno corto, MARIA/JOSE y antisonantes", () => {
    expect(letrasRfc("Juan", "Pérez", null)).toBe("PEJU");
    expect(letrasRfc("Alicia", "Ro", "Sánchez")).toBe("RSAL");
    expect(letrasRfc("María José", "Ramírez", "Ortiz")).toBe("RAOJ");
    expect(letrasRfc("Isabel", "Buendía", "Eslava")).toBe("BUEX");
    expect(letrasRfc("Emma", "Gómez", "Díaz")).toBe("GODE");
  });
});

describe("cruzarCurpRfc", () => {
  const curpOrtega = calcularCurp({ nombres: "María Fernanda", primerApellido: "Ortega", segundoApellido: "Ruiz", fechaNacimiento: "1992-03-14", sexo: "M", entidadClave: "PL" });
  const rfcOrtega = calcularRfc({ nombres: "María Fernanda", primerApellido: "Ortega", segundoApellido: "Ruiz", fechaNacimiento: "1992-03-14" });

  it("CURP y RFC del mismo nombre y fecha coinciden en los 10 primeros caracteres", () => {
    if (!curpOrtega.ok || !rfcOrtega.ok) throw new Error("fixtures");
    expect(cruzarCurpRfc(curpOrtega.curp, rfcOrtega.rfc)).toBe("COINCIDE");
    expect(cruzarCurpRfc(curpOrtega.curp, "GODE561231GR8")).toBe("DIFIERE");
    expect(cruzarCurpRfc(curpOrtega.curp, null)).toBe("SIN_RFC");
    expect(cruzarCurpRfc(null, rfcOrtega.rfc)).toBe("NO_APLICA");
    expect(cruzarCurpRfc(curpOrtega.curp, "XEXX010101000")).toBe("NO_APLICA");
    expect(cruzarCurpRfc(curpOrtega.curp, "HHH190215K73")).toBe("NO_APLICA");
  });

  it("la X de los antisonantes (posición distinta en CURP y RFC) cuenta como comodín", () => {
    expect(cruzarCurpRfc("BXEI800101MPLNSS04", "BUEX800101AB1")).toBe("COINCIDE");
  });

  it("sin segundo apellido el RFC usa dos letras del nombre: se cruzan las dos primeras letras y la fecha", () => {
    expect(cruzarCurpRfc("TOXA800101MPLRXN09", "TOAN800101AB1")).toBe("COINCIDE");
    expect(cruzarCurpRfc("TOXA800101MPLRXN09", "PEAN800101AB1")).toBe("DIFIERE");
    expect(cruzarCurpRfc("TOXA800101MPLRXN09", "TOAN800102AB1")).toBe("DIFIERE");
  });
});

describe("compararConRenapo", () => {
  it("ignora acentos, mayúsculas y espacios; lista las diferencias reales", () => {
    const ok = compararConRenapo(
      { nombres: "María  Fernanda", primerApellido: "ortega", segundoApellido: "Ruíz", fechaNacimiento: "1992-03-14", sexo: "FEMENINO" },
      { nombres: "MARIA FERNANDA", primerApellido: "ORTEGA", segundoApellido: "RUIZ", fechaNacimiento: "1992-03-14", sexo: "MUJER" }
    );
    expect(ok).toEqual({ coincide: true, diferencias: [] });
    const mal = compararConRenapo(
      { nombres: "Ma. Fernanda", primerApellido: "Ortega", segundoApellido: null, fechaNacimiento: "1992-03-15", sexo: "F" },
      { nombres: "MARIA FERNANDA", primerApellido: "ORTEGA", segundoApellido: "RUIZ", fechaNacimiento: "1992-03-14", sexo: "M" }
    );
    expect(mal.coincide).toBe(false);
    expect(mal.diferencias.map((d) => d.campo)).toEqual(["nombres", "segundoApellido", "fechaNacimiento"]);
  });
});

describe("dividirNombre", () => {
  it("quita títulos, respeta partículas y segundos nombres frecuentes", () => {
    expect(dividirNombre("Dr. Alonso Vega")).toEqual({ nombres: "Alonso", apellidoPaterno: "Vega", apellidoMaterno: null });
    expect(dividirNombre("María Fernanda Ortega Ruiz")).toEqual({ nombres: "María Fernanda", apellidoPaterno: "Ortega", apellidoMaterno: "Ruiz" });
    expect(dividirNombre("Juan de la Cruz Pérez")).toEqual({ nombres: "Juan", apellidoPaterno: "de la Cruz", apellidoMaterno: "Pérez" });
    expect(dividirNombre("Ana Sofía Bermúdez")).toEqual({ nombres: "Ana Sofía", apellidoPaterno: "Bermúdez", apellidoMaterno: null });
    expect(dividirNombre("Silvia Márquez Toledo")).toEqual({ nombres: "Silvia", apellidoPaterno: "Márquez", apellidoMaterno: "Toledo" });
    expect(dividirNombre("Dra.")).toBeNull();
    expect(dividirNombre("Cher")).toBeNull();
  });
});

describe("identidadDePaciente", () => {
  const base: PacienteIdentidadEntrada = {
    curp: "OERF920314MPLRZR09",
    sinCurp: false,
    sinCurpMotivo: null,
    curpValidada: true,
    curpOrigen: "CAPTURA",
    curpEstatus: null,
    curpVerificadaAt: null,
    curpVerificadaFuente: null,
    curpVerificadaRef: null,
    renapoCoincide: null,
    curpProbable: false,
    rfc: null,
    rfcFuente: null,
    identificacionTipo: null,
    identificacionNumero: null,
    identificacionVigencia: null,
    avisoPrivacidadVersion: null,
    avisoPrivacidadAceptadoAt: null,
  };
  const hoy = new Date("2026-09-05T18:00:00.000Z");

  it("una ficha recién capturada tiene pendientes de RENAPO, identificación y aviso", () => {
    const r = identidadDePaciente(base, { avisoPrivacidadVersion: "2026-09" }, hoy);
    expect(r.curp.activa).toBeNull();
    expect(r.rfc.cruceCurp).toBe("SIN_RFC");
    expect(r.pendientes).toEqual(["CURP sin verificar en RENAPO", "Sin identificación oficial registrada", "Aviso de privacidad sin firma"]);
  });

  it("verificada en RENAPO, con RFC coherente, INE vigente y aviso vigente: sin pendientes", () => {
    const r = identidadDePaciente(
      {
        ...base,
        curpOrigen: "RENAPO",
        curpEstatus: "AN",
        curpVerificadaAt: new Date("2026-09-01T10:00:00Z"),
        curpVerificadaFuente: "tlaloc",
        renapoCoincide: true,
        rfc: "OERF920314AB1",
        rfcFuente: "CSF",
        identificacionTipo: "INE",
        identificacionNumero: "ORRZFR92031421M100",
        identificacionVigencia: new Date("2031-12-31T12:00:00Z"),
        avisoPrivacidadVersion: "2026-09",
        avisoPrivacidadAceptadoAt: new Date("2026-08-01T10:00:00Z"),
      },
      { avisoPrivacidadVersion: "2026-09" },
      hoy
    );
    expect(r.pendientes).toEqual([]);
    expect(r.curp).toMatchObject({ activa: true, estatus: "AN", estatusDescripcion: "Alta normal", coincide: true });
    expect(r.rfc.cruceCurp).toBe("COINCIDE");
    expect(r.identificacion.vencida).toBe(false);
    expect(r.avisoPrivacidad.vigente).toBe(true);
  });

  it("baja en RENAPO, RFC que difiere, identificación vencida y aviso viejo: todo se lista", () => {
    const r = identidadDePaciente(
      {
        ...base,
        curpOrigen: "RENAPO",
        curpEstatus: "BD",
        curpVerificadaAt: new Date("2026-09-01T10:00:00Z"),
        renapoCoincide: false,
        rfc: "GODE561231GR8",
        rfcFuente: "CAPTURA",
        identificacionTipo: "INE",
        identificacionVigencia: new Date("2025-12-31T12:00:00Z"),
        avisoPrivacidadVersion: "2026-01",
        avisoPrivacidadAceptadoAt: new Date("2026-02-01T10:00:00Z"),
      },
      { avisoPrivacidadVersion: "2026-09" },
      hoy
    );
    expect(r.curp.activa).toBe(false);
    expect(r.pendientes).toEqual([
      "CURP dada de baja en RENAPO (BD: Baja por defunción)",
      "Los datos capturados no coinciden con los de RENAPO",
      "El RFC no coincide con la CURP (10 primeros caracteres)",
      "Identificación vencida",
      "Aviso de privacidad firmado en una versión anterior (2026-01; vigente 2026-09)",
    ]);
  });

  it("extranjero: sin CURP con motivo, pasaporte y RFC genérico no generan falsas alertas", () => {
    const r = identidadDePaciente(
      {
        ...base,
        curp: null,
        curpValidada: false,
        curpOrigen: null,
        sinCurp: true,
        sinCurpMotivo: "Extranjera sin CURP (pasaporte)",
        rfc: "XEXX010101000",
        rfcFuente: "CAPTURA",
        identificacionTipo: "PASAPORTE",
        identificacionNumero: "5X1234567",
        identificacionVigencia: new Date("2031-05-01T12:00:00Z"),
        avisoPrivacidadVersion: "2026-09",
        avisoPrivacidadAceptadoAt: new Date("2026-08-01T10:00:00Z"),
      },
      { avisoPrivacidadVersion: "2026-09" },
      hoy
    );
    expect(r.pendientes).toEqual([]);
    expect(r.rfc).toMatchObject({ generico: true, cruceCurp: "NO_APLICA" });
  });

  it("CURP probable (calculada) queda como pendiente de confirmar", () => {
    const r = identidadDePaciente({ ...base, curpOrigen: "CALCULADA", curpProbable: true }, null, hoy);
    expect(r.pendientes[0]).toBe("CURP sin verificar en RENAPO");
    expect(r.pendientes[1]).toMatch(/CURP calculada/);
  });
});

describe("RFC propuesto en la ficha", () => {
  const base = {
    nombre: "MARIA FERNANDA",
    apellidoPaterno: "ORTEGA",
    apellidoMaterno: "RIVAS",
    fechaNacimiento: "1992-03-14",
    curp: "OERF920314MPLRVR09",
    sinCurp: false, sinCurpMotivo: null, curpValidada: true, curpOrigen: null, curpEstatus: null,
    curpVerificadaAt: null, curpVerificadaFuente: null, curpVerificadaRef: null, renapoCoincide: null,
    curpProbable: false, rfc: null, rfcFuente: null,
    identificacionTipo: null, identificacionNumero: null, identificacionVigencia: null,
    avisoPrivacidadVersion: null, avisoPrivacidadAceptadoAt: null,
  } as const;

  it("propone el RFC cuando hay nombre y fecha", () => {
    const r = identidadDePaciente({ ...base }, null);
    expect(r.rfc.calculado).toBe("OERF920314FV3");
    expect(r.rfc.valor).toBeNull();
  });

  it("sin fecha de nacimiento no propone nada", () => {
    expect(identidadDePaciente({ ...base, fechaNacimiento: null }, null).rfc.calculado).toBeNull();
  });

  it("sin nombre no propone nada", () => {
    expect(identidadDePaciente({ ...base, apellidoPaterno: "" }, null).rfc.calculado).toBeNull();
  });

  // LO QUE NO DEBE PASAR. La homoclave la asigna el SAT y ante homonimia le
  // toca otra a cada quien: el calculado puede diferir del real siendo los dos
  // correctos. Convertir esa diferencia en un pendiente llenaría la ficha de
  // alarmas falsas justo en los pacientes que SÍ traen su RFC bueno.
  it("que el calculado difiera del RFC en ficha no levanta pendiente", () => {
    const r = identidadDePaciente({ ...base, rfc: "OERF920314QZ8", rfcFuente: "CSF" }, null);
    expect(r.rfc.calculado).toBe("OERF920314FV3");
    expect(r.rfc.valor).toBe("OERF920314QZ8");
    expect(r.pendientes.join(" ")).not.toMatch(/RFC/i);
  });

  // El cruce con la CURP sí es un error real: son los mismos diez caracteres.
  it("pero un RFC de otra persona sí lo levanta", () => {
    const r = identidadDePaciente({ ...base, rfc: "PECJ680602CS5", rfcFuente: "CAPTURA" }, null);
    expect(r.rfc.cruceCurp).toBe("DIFIERE");
    expect(r.pendientes.join(" ")).toMatch(/no coincide con la CURP/i);
  });
});
