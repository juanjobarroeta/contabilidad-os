import { describe, it, expect } from "vitest";
import { validarRfc, validarCurp, validarNss } from "./estructura";

// Los RFC/CURP de referencia son identificadores REALES emitidos por el SAT y
// RENAPO (constancias y CFDIs vistos en el desarrollo) — si el algoritmo del
// dígito verificador está mal, estos casos truenan.

describe("validarRfc", () => {
  it("RFCs reales de persona física validan (formato + dígito)", () => {
    for (const rfc of ["COOF821223RC4", "MEMJ830818K30", "SETJ920918419", "DODY870729UW5"]) {
      const r = validarRfc(rfc);
      expect(r.formatoValido, rfc).toBe(true);
      expect(r.digitoVerificador, rfc).toBe("valido");
      expect(r.esPersonaMoral, rfc).toBe(false);
    }
  });

  it("normaliza minúsculas y espacios", () => {
    const r = validarRfc("  coof821223rc4 ");
    expect(r.valor).toBe("COOF821223RC4");
    expect(r.digitoVerificador).toBe("valido");
  });

  it("dedazo en un carácter → dígito inválido (el caso que queremos cachar)", () => {
    const r = validarRfc("COOF821223RC5"); // último dígito alterado
    expect(r.formatoValido).toBe(true);
    expect(r.digitoVerificador).toBe("invalido");
    const r2 = validarRfc("COOF821224RC4"); // fecha alterada
    expect(r2.digitoVerificador).toBe("invalido");
  });

  it("formato inválido → no evaluable", () => {
    expect(validarRfc("NOESUNRFC").formatoValido).toBe(false);
    expect(validarRfc("COOF821323RC4").formatoValido).toBe(false); // mes 13
    expect(validarRfc("").formatoValido).toBe(false);
  });

  it("persona moral (12 caracteres) se distingue", () => {
    // Estructura PM válida; el dígito se evalúa con el ajuste de 12 posiciones.
    const r = validarRfc("ABC680524P76");
    expect(r.esPersonaMoral).toBe(true);
    expect(r.formatoValido).toBe(true);
  });
});

describe("validarCurp", () => {
  it("CURPs reales validan (formato + dígito)", () => {
    for (const curp of ["COOF821223HPLRRR05", "SETJ920918HPLMRS09"]) {
      const r = validarCurp(curp);
      expect(r.formatoValido, curp).toBe(true);
      expect(r.digitoVerificador, curp).toBe("valido");
    }
  });

  it("dedazo → dígito inválido", () => {
    expect(validarCurp("COOF821223HPLRRR06").digitoVerificador).toBe("invalido");
    expect(validarCurp("COOF821224HPLRRR05").digitoVerificador).toBe("invalido");
  });

  it("formato inválido → no evaluable", () => {
    expect(validarCurp("COOF821223HPLRRR0").formatoValido).toBe(false); // 17 chars
    expect(validarCurp("COOF821223XPLRRR05").formatoValido).toBe(false); // sexo X
  });
});

describe("validarNss", () => {
  // El NSS usa Luhn estándar: estos valores se verifican por la propiedad del
  // algoritmo (alterar cualquier dígito rompe la suma módulo 10).
  const nssValido = (() => {
    // Construir un NSS con dígito verificador correcto para la base 1234567890.
    const base = "1234567890";
    for (let d = 0; d <= 9; d++) {
      const candidato = base + String(d);
      let suma = 0;
      for (let i = 0; i < 11; i++) {
        let x = Number(candidato[10 - i]);
        if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
        suma += x;
      }
      if (suma % 10 === 0) return candidato;
    }
    throw new Error("sin dígito válido");
  })();

  it("NSS con Luhn correcto valida; alterar un dígito lo invalida", () => {
    expect(validarNss(nssValido).digitoVerificador).toBe("valido");
    const alterado = nssValido.slice(0, 4) + ((Number(nssValido[4]) + 1) % 10) + nssValido.slice(5);
    expect(validarNss(alterado).digitoVerificador).toBe("invalido");
  });

  it("acepta espacios y guiones de captura", () => {
    const conFormato = `${nssValido.slice(0, 2)}-${nssValido.slice(2, 4)}-${nssValido.slice(4)}`;
    expect(validarNss(conFormato).digitoVerificador).toBe("valido");
  });

  it("formato inválido → no evaluable", () => {
    expect(validarNss("123").formatoValido).toBe(false);
    expect(validarNss("1234567890A").formatoValido).toBe(false);
  });
});
